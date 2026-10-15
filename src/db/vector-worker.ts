import { parentPort } from "node:worker_threads";
import { int8Similarity, TopK } from "./vectors.js";
import { ADMISSION_CAP, type ScanRequest, type ScanResult } from "./vector-cache.js";

parentPort!.on("message", (request: ScanRequest) => {
  const { dimensions, start, end, unit, limit, floor } = request;
  const vectors = new Int8Array(request.vectors),
    order = new Float64Array(request.order);
  const top = new TopK(limit),
    admissions: ScanResult["admissions"] = [];
  for (let i = start; i < end; i++) {
    const id = order[2 * i]!,
      slot = order[2 * i + 1]!;
    const score = int8Similarity(unit, vectors.subarray(slot * dimensions, (slot + 1) * dimensions));
    if (score <= 0 || score < floor || score <= top.floor) continue;
    if (admissions.length === ADMISSION_CAP) {
      parentPort!.postMessage({ admissions: [], capped: true } satisfies ScanResult);
      return;
    }
    top.push(score, id);
    admissions.push({ id, score });
  }
  parentPort!.postMessage({ admissions, capped: false } satisfies ScanResult);
});
