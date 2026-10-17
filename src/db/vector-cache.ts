/// <reference lib="es2024.sharedmemory" />
/** The queue owns mutable buffers; workers only read an immutable dispatch. */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { log } from "../logger.js";
import type { Connection } from "./connection.js";
import { TopK } from "./vectors.js";

export const ADMISSION_CAP = 4096;
const DIRTY_THRESHOLD = 4096;
const BOOKKEEPING_BYTES = 56; // IDs plus three reusable (ID, slot) indexes.
export interface ScanRequest {
  vectors: SharedArrayBuffer;
  order: SharedArrayBuffer;
  dimensions: number;
  start: number;
  end: number;
  unit: Float64Array;
  limit: number;
  floor: number;
}
export interface ScoredId {
  id: number;
  score: number;
}
export interface ScanResult {
  admissions: ScoredId[];
  capped: boolean;
}
export interface VectorCacheStatus {
  state: "cold" | "loading" | "reconciling" | "ready" | "recovering" | "failed" | "disabled";
  reason?: string;
  sharedBytes: number;
  recoveries: number;
  capFallbacks: number;
}
interface Row {
  message_id: number;
  model: string;
  vec: Uint8Array;
}
class CacheLimit extends Error {}
class CacheCancelled extends Error {}

/** Opt-in: unset or 0 keeps every search on SQLite, with no cache or workers. */
export function cacheLimitBytes(): number {
  const raw = process.env.WAZAP_RECALL_CACHE_MAX_MB?.trim() || "0";
  const n = Number(raw);
  if (Number.isSafeInteger(n) && n >= 0 && n <= 1048576) return n * 1048576;
  log("recall cache: invalid WAZAP_RECALL_CACHE_MAX_MB; using SQLite");
  return 0;
}

export class VectorCache {
  private model = "";
  private dimensions = 0;
  private loaded = false;
  private generation = 0;
  private completeDimensions = true;
  private closed = false;
  private vectors = new Int8Array(new SharedArrayBuffer(0));
  private ids = new Float64Array(new SharedArrayBuffer(0));
  private order = new Float64Array(new SharedArrayBuffer(0));
  private incoming = new Float64Array(new SharedArrayBuffer(0));
  private scratch = new Float64Array(new SharedArrayBuffer(0));
  private orderCount = 0;
  private orderDirty = false;
  private incomingCount = 0;
  private readonly slots = new Map<number, number>();
  private readonly free: number[] = [];
  private used = 0;
  private capacity = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private warming: Promise<void> | null = null;
  private working = false;
  private state: VectorCacheStatus["state"] = "cold";
  private reason: string | undefined;
  private blocked = false;
  private recoveries = 0;
  private capFallbacks = 0;
  private retryAt = 0;
  private version = 0;
  private maxBytes = cacheLimitBytes();
  private recoveryDelayMs = 1000;
  private scanTimeoutMs = 15000;
  private warmTimeoutMs = 60000;
  private workers: Worker[] = [];
  private readonly pending = new Map<
    Worker,
    { resolve: (hits: ScanResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly c: Connection) {
    if (this.maxBytes > 0)
      c.db.exec(`CREATE TEMP TABLE vector_cache_dirty(id INTEGER PRIMARY KEY);
      CREATE TEMP TRIGGER vector_cache_insert AFTER INSERT ON main.embeddings BEGIN
        INSERT INTO vector_cache_dirty VALUES (new.message_id) ON CONFLICT(id) DO NOTHING; END;
      CREATE TEMP TRIGGER vector_cache_update AFTER UPDATE ON main.embeddings BEGIN
        INSERT INTO vector_cache_dirty VALUES (old.message_id) ON CONFLICT(id) DO NOTHING;
        INSERT INTO vector_cache_dirty VALUES (new.message_id) ON CONFLICT(id) DO NOTHING; END;
      CREATE TEMP TRIGGER vector_cache_delete AFTER DELETE ON main.embeddings BEGIN
        INSERT INTO vector_cache_dirty VALUES (old.message_id) ON CONFLICT(id) DO NOTHING; END;`);
    this.timer = setInterval(() => this.maintain(), 250);
    this.timer.unref();
  }

  status(): VectorCacheStatus {
    return {
      state: this.state,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      sharedBytes: this.sharedBytes(),
      recoveries: this.recoveries,
      capFallbacks: this.capFallbacks,
    };
  }

  indexedCount(model: string): number | undefined {
    if (
      this.state !== "ready" ||
      model !== this.model ||
      !this.completeDimensions ||
      this.dataVersion() !== this.version ||
      this.c.get("SELECT id FROM vector_cache_dirty LIMIT 1") !== undefined
    )
      return undefined;
    return this.slots.size;
  }

  private sharedBytes(): number {
    return (
      this.vectors.byteLength +
      this.ids.byteLength +
      this.order.byteLength +
      this.incoming.byteLength +
      this.scratch.byteLength
    );
  }

  private dataVersion(): number {
    return this.c.get<{ data_version: number }>("PRAGMA data_version")!.data_version;
  }
  private largeBacklog(): boolean {
    return this.c.get(`SELECT id FROM vector_cache_dirty LIMIT 1 OFFSET ${DIRTY_THRESHOLD}`) !== undefined;
  }

  ready(model: string, dimensions: number | undefined): boolean {
    if (
      this.closed ||
      this.blocked ||
      this.state !== "ready" ||
      !this.loaded ||
      model !== this.model ||
      dimensions !== this.dimensions
    )
      return false;
    if (this.dataVersion() !== this.version) {
      this.loaded = false;
      this.state = "cold";
      void this.warm(this.model, this.dimensions);
      return false;
    }
    if (this.largeBacklog()) {
      this.state = "reconciling";
      this.maintain();
      return false;
    }
    return true;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => {});
    return run;
  }

  private maintain(): void {
    if (this.closed || this.blocked || this.working || this.warming !== null || this.c.db.isTransaction) return;
    if (this.state === "recovering") {
      if (Date.now() < this.retryAt) return;
      this.recoveries++;
      this.state = "cold";
      void this.warm(this.model, this.dimensions);
    } else if (
      this.loaded &&
      (this.state === "reconciling" || this.c.get("SELECT id FROM vector_cache_dirty LIMIT 1") !== undefined)
    ) {
      this.state = "reconciling";
      this.working = true;
      const generation = this.generation;
      void this.enqueue(async () => {
        try {
          this.checkGeneration(generation);
          await this.sync();
          this.checkGeneration(generation);
          if (this.dataVersion() !== this.version) {
            this.loaded = false;
            this.state = "cold";
            void this.warm(this.model, this.dimensions);
          } else if (this.loaded && this.state === "reconciling") {
            this.state = this.largeBacklog() ? "reconciling" : "ready";
          }
        } catch (error) {
          if (!(error instanceof CacheCancelled) && this.canFail()) this.fail(error);
        } finally {
          this.working = false;
        }
      });
    }
  }

  warm(model: string, dimensions?: number): Promise<void> {
    if (this.closed || this.blocked || this.state === "recovering") return Promise.resolve();
    if (this.warming !== null) return this.warming;
    if (this.loaded && model === this.model && (dimensions === undefined || dimensions === this.dimensions)) {
      this.maintain();
      return Promise.resolve();
    }
    const requestedGeneration = this.generation;
    this.warming = this.enqueue(async () => {
      if (this.closed || this.blocked || requestedGeneration !== this.generation || this.state === "recovering") return;
      const previousGeneration = this.generation;
      this.state = "loading";
      await this.stopWorkers();
      if (this.closed) return;
      this.checkGeneration(previousGeneration);
      this.model = model;
      this.release();
      const generation = this.generation;
      const deadline = Date.now() + this.warmTimeoutMs;
      try {
        if (this.maxBytes === 0) throw new CacheLimit("disabled");
        this.version = this.dataVersion();
        let after = 0,
          count = 0;
        this.completeDimensions = true;
        this.dimensions = dimensions ?? 0;
        // Count bounded primary-key pages, not a synchronous full-table COUNT.
        for (;;) {
          this.checkDeadline(deadline);
          const rows = this.c.all<{ message_id: number; model: string; dimensions: number }>(
            "SELECT message_id, model, length(vec) AS dimensions FROM embeddings WHERE message_id > ? ORDER BY message_id LIMIT 256",
            after
          );
          if (rows.length === 0) break;
          for (const row of rows)
            if (row.model === model) {
              if (this.dimensions === 0) this.dimensions = row.dimensions;
              if (row.dimensions === this.dimensions) count++;
              else this.completeDimensions = false;
            }
          after = rows[rows.length - 1]!.message_id;
          await this.checkedYield(generation);
        }
        const maximum = Math.floor(this.maxBytes / (this.dimensions + BOOKKEEPING_BYTES));
        if (count > maximum) throw new CacheLimit("size_limit");
        await this.allocate(Math.min(maximum, count + Math.max(1024, Math.ceil(count / 10))));
        this.checkGeneration(generation);
        after = 0;
        for (;;) {
          this.checkDeadline(deadline);
          const rows = this.c.all<Row>(
            "SELECT message_id, model, vec FROM embeddings WHERE message_id > ? ORDER BY message_id LIMIT 256",
            after
          );
          if (rows.length === 0) break;
          await this.capacityFor(
            rows.filter(
              (row) => row.model === model && row.vec.length === this.dimensions && !this.slots.has(row.message_id)
            ).length
          );
          this.checkGeneration(generation);
          for (const row of rows) if (row.model === model && row.vec.length === this.dimensions) this.put(row);
          after = rows[rows.length - 1]!.message_id;
          await this.checkedYield(generation);
        }
        await this.mergeOrder();
        this.checkGeneration(generation);
        await this.sync();
        this.checkGeneration(generation);
        this.checkDeadline(deadline);
        if (this.dataVersion() !== this.version) throw new Error("external_change");
        this.loaded = true;
        this.reason = undefined;
        this.state = "ready";
      } catch (error) {
        if (!(error instanceof CacheCancelled) && this.canFail()) this.fail(error);
      }
    }).finally(() => {
      this.warming = null;
    });
    return this.warming;
  }

  private checkDeadline(deadline: number): void {
    if (this.closed || this.state === "recovering" || this.blocked) throw new Error("cancelled");
    if (Date.now() > deadline) throw new Error("warm_timeout");
  }
  private checkGeneration(generation: number): void {
    if (this.closed || generation !== this.generation || this.blocked || this.state === "recovering") {
      throw new CacheCancelled();
    }
  }

  private async checkedYield(generation: number): Promise<void> {
    await this.yield();
    this.checkGeneration(generation);
  }

  private yield(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  private async allocate(capacity: number): Promise<void> {
    const generation = this.generation;
    this.checkGeneration(generation);
    const maximum = Math.floor(this.maxBytes / (this.dimensions + BOOKKEEPING_BYTES));
    if (capacity > maximum) throw new CacheLimit("size_limit");
    const sizes = [capacity * this.dimensions, capacity * 8, capacity * 16, capacity * 16, capacity * 16];
    const maxSizes = [maximum * this.dimensions, maximum * 8, maximum * 16, maximum * 16, maximum * 16];
    const current = [this.vectors, this.ids, this.order, this.incoming, this.scratch];
    const buffers: SharedArrayBuffer[] = [];
    for (let i = 0; i < current.length; i++) {
      const source = current[i]!;
      if (source.buffer.growable) {
        source.buffer.grow(sizes[i]);
        buffers.push(source.buffer);
      } else {
        const buffer = new SharedArrayBuffer(sizes[i], { maxByteLength: maxSizes[i] });
        // Older runtimes may ignore the growable option: bound copy pauses and
        // refuse a growth that would exceed the configured temporary peak.
        if (source.byteLength > 0 && this.sharedBytes() + sizes.reduce((a, b) => a + b, 0) > this.maxBytes)
          throw new CacheLimit("growth_peak_limit");
        const bytes = new Uint8Array(buffer),
          old = new Uint8Array(source.buffer);
        for (let offset = 0; offset < old.length; offset += 1048576) {
          bytes.set(old.subarray(offset, Math.min(old.length, offset + 1048576)), offset);
          await this.checkedYield(generation);
          if (this.closed || this.state === "recovering" || this.blocked) throw new Error("cancelled");
        }
        buffers.push(buffer);
      }
    }
    this.checkGeneration(generation);
    this.vectors = new Int8Array(buffers[0]!);
    this.ids = new Float64Array(buffers[1]!);
    this.order = new Float64Array(buffers[2]!);
    this.incoming = new Float64Array(buffers[3]!);
    this.scratch = new Float64Array(buffers[4]!);
    this.capacity = capacity;
  }

  private async capacityFor(rows: number): Promise<void> {
    const generation = this.generation;
    this.checkGeneration(generation);
    const needed = Math.max(this.used + Math.max(0, rows - this.free.length), this.incomingCount + rows);
    if (needed <= this.capacity) return;
    const maximum = Math.floor(this.maxBytes / (this.dimensions + BOOKKEEPING_BYTES));
    if (needed > maximum) throw new CacheLimit("size_limit");
    await this.allocate(
      Math.min(maximum, Math.max(needed, this.capacity + Math.max(1024, Math.ceil(this.capacity / 10))))
    );
    this.checkGeneration(generation);
  }

  private put(row: { message_id: number; vec: Uint8Array }): void {
    let slot = this.slots.get(row.message_id);
    if (slot === undefined) {
      slot = this.free.pop() ?? this.used++;
      this.slots.set(row.message_id, slot);
      this.orderDirty = true;
      this.incoming[2 * this.incomingCount] = row.message_id;
      this.incoming[2 * this.incomingCount++ + 1] = slot;
    }
    this.ids[slot] = row.message_id;
    this.vectors.set(new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength), slot * this.dimensions);
  }

  private async mergeOrder(): Promise<void> {
    const generation = this.generation;
    this.checkGeneration(generation);
    if (!this.orderDirty) return;
    let a = 0,
      b = 0,
      n = 0;
    while (a < this.orderCount || b < this.incomingCount) {
      const oldId = this.order[2 * a]!,
        newId = this.incoming[2 * b]!;
      const takeOld = b === this.incomingCount || (a < this.orderCount && oldId < newId);
      if (!takeOld && a < this.orderCount && oldId === newId) a++;
      const id = takeOld ? oldId : newId,
        slot = takeOld ? this.order[2 * a++ + 1]! : this.incoming[2 * b++ + 1]!;
      if (this.ids[slot] === id) {
        this.scratch[2 * n] = id;
        this.scratch[2 * n++ + 1] = slot;
      }
      if ((a + b) % 2048 === 0) {
        await this.checkedYield(generation);
        if (this.closed || this.state === "recovering" || this.blocked) throw new Error("cancelled");
      }
    }
    [this.order, this.scratch] = [this.scratch, this.order];
    this.orderCount = n;
    this.incomingCount = 0;
    this.orderDirty = false;
  }

  private async sync(): Promise<void> {
    const generation = this.generation;
    this.checkGeneration(generation);
    const last = this.c.get<{ id: number }>("SELECT id FROM vector_cache_dirty ORDER BY id DESC LIMIT 1")?.id ?? 0;
    let after = 0;
    while (!this.closed && after < last) {
      const rows = this.c.all<{ id: number; model: string | null; vec: Uint8Array | null }>(
        `SELECT d.id,e.model,e.vec FROM vector_cache_dirty d LEFT JOIN embeddings e ON e.message_id=d.id WHERE d.id>? AND d.id<=? ORDER BY d.id LIMIT 128`,
        after,
        last
      );
      if (rows.length === 0) break;
      const additions = rows.filter(
        (row) =>
          row.model === this.model && row.vec !== null && row.vec.length === this.dimensions && !this.slots.has(row.id)
      ).length;
      if (
        Math.max(this.used + Math.max(0, additions - this.free.length), this.incomingCount + additions) > this.capacity
      ) {
        await this.capacityFor(additions);
        if (this.closed || this.state === "recovering" || this.blocked) throw new Error("cancelled");
        continue; // Re-read after a yielding growth, before consuming any IDs.
      }
      // Capacity growth may yield: consume only once the cache can apply this
      // batch synchronously; a later write reinserts the ID for the next pass.
      for (const row of rows) {
        const slot = this.slots.get(row.id);
        if (row.model === this.model && row.vec !== null && row.vec.length !== this.dimensions)
          this.completeDimensions = false;
        if (row.model === this.model && row.vec !== null && row.vec.length === this.dimensions)
          this.put({ message_id: row.id, vec: row.vec });
        else if (slot !== undefined) {
          this.ids[slot] = 0;
          this.slots.delete(row.id);
          this.free.push(slot);
          this.orderDirty = true;
        }
      }
      this.c.run(
        "DELETE FROM vector_cache_dirty WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify(rows.map((row) => row.id))
      );
      after = rows[rows.length - 1]!.id;
      await this.checkedYield(generation);
    }
    this.checkGeneration(generation);
    await this.mergeOrder();
    this.checkGeneration(generation);
  }

  private startWorkers(): void {
    if (this.workers.length !== 0) return;
    for (let i = 0; i < Math.max(1, Math.min(4, availableParallelism() - 1)); i++) {
      const worker = new Worker(new URL("./vector-worker.js", import.meta.url));
      worker.on("message", (hits: ScanResult) => {
        const task = this.pending.get(worker);
        this.pending.delete(worker);
        worker.unref();
        if (task) {
          clearTimeout(task.timer);
          task.resolve(hits);
        }
      });
      const failed = () => {
        if (this.workers.includes(worker)) this.fail(new Error("worker_failure"));
      };
      worker.on("error", failed);
      worker.on("exit", failed);
      worker.unref();
      this.workers.push(worker);
    }
  }

  private scan(worker: Worker, request: ScanRequest): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("scan_timeout")), this.scanTimeoutMs);
      this.pending.set(worker, { resolve, reject, timer });
      worker.ref();
      worker.postMessage(request);
    });
  }

  rank(model: string, unit: Float64Array, limit: number, floor: number): Promise<ScoredId[] | null> {
    if (!this.ready(model, unit.length) || this.c.db.isTransaction) return Promise.resolve(null);
    return this.enqueue(async () => {
      if (!this.ready(model, unit.length) || this.c.db.isTransaction) return null;
      this.working = true;
      const generation = this.generation;
      try {
        await this.sync();
        this.checkGeneration(generation);
        if (this.closed || !this.loaded) return null;
        this.startWorkers();
        const k = Math.max(1, Math.floor(limit));
        if (k > ADMISSION_CAP) {
          this.capFallbacks++;
          return null;
        }
        const span = Math.ceil(this.orderCount / this.workers.length);
        const parts = await Promise.all(
          this.workers.map((worker, i) =>
            this.scan(worker, {
              vectors: this.vectors.buffer,
              order: this.order.buffer,
              dimensions: this.dimensions,
              start: i * span,
              end: Math.min(this.orderCount, (i + 1) * span),
              unit,
              limit: k,
              floor,
            })
          )
        );
        this.checkGeneration(generation);
        if (parts.some((part) => part.capped)) {
          this.capFallbacks++;
          return null;
        }
        if (this.closed || this.dataVersion() !== this.version) {
          this.loaded = false;
          this.state = "cold";
          if (!this.closed) void this.warm(this.model, this.dimensions);
          return null;
        }
        // Every locally rejected score is below the global prefix's floor.
        // Replaying all local admissions reproduces the original heap history.
        const candidates = parts.flatMap((part) => part.admissions).sort((a, b) => a.id - b.id);
        const top = new TopK(k);
        for (const hit of candidates) if (hit.score > top.floor) top.push(hit.score, hit.id);
        const hits = top.sorted();
        const changed = new Set(
          this.c
            .all<{ id: number }>(
              "SELECT id FROM vector_cache_dirty WHERE id IN (SELECT value FROM json_each(?))",
              JSON.stringify(hits.map((hit) => hit.id))
            )
            .map((row) => row.id)
        );
        return hits.filter((hit) => !changed.has(hit.id));
      } catch (error) {
        if (!(error instanceof CacheCancelled) && this.canFail()) this.fail(error);
        return null;
      } finally {
        this.working = false;
      }
    });
  }

  private canFail(): boolean {
    return !this.closed && this.state !== "recovering" && !this.blocked;
  }

  private fail(error: unknown): void {
    const permanent = error instanceof CacheLimit || error instanceof RangeError;
    const code =
      error instanceof Error &&
      ["scan_timeout", "warm_timeout", "worker_failure", "external_change"].includes(error.message)
        ? error.message
        : "worker_or_warm_failure";
    this.reason =
      error instanceof CacheLimit ? error.message : error instanceof RangeError ? "allocation_failed" : code;
    this.state = error instanceof CacheLimit ? "disabled" : permanent || this.recoveries >= 3 ? "failed" : "recovering";
    this.blocked = permanent || this.recoveries >= 3;
    this.retryAt = Date.now() + this.recoveryDelayMs * 2 ** this.recoveries;
    void this.stopWorkers();
    this.release();
    log(`recall cache: ${this.reason}; using SQLite${this.state === "recovering" ? " until bounded recovery" : ""}`);
  }

  private stopWorkers(): Promise<void> {
    const workers = this.workers;
    this.workers = [];
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("Vector worker stopped"));
    }
    this.pending.clear();
    return Promise.all(workers.map((worker) => worker.terminate().catch(() => 0))).then(() => {});
  }
  private release(): void {
    this.generation++;
    this.loaded = false;
    this.used = 0;
    this.capacity = 0;
    this.orderCount = 0;
    this.incomingCount = 0;
    this.slots.clear();
    this.free.length = 0;
    this.vectors = new Int8Array(new SharedArrayBuffer(0));
    this.ids = new Float64Array(new SharedArrayBuffer(0));
    this.order = new Float64Array(new SharedArrayBuffer(0));
    this.incoming = new Float64Array(new SharedArrayBuffer(0));
    this.scratch = new Float64Array(new SharedArrayBuffer(0));
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    void this.stopWorkers();
    this.release();
  }
}
