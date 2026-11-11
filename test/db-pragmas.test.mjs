/**
 * The pragmas of the server's own connection: write-ahead log checkpoints off
 * the commit path — commits stop checkpointing below a ~40 MB backstop, and a
 * passive checkpoint from a timer moves the log into the database file once
 * writes go quiet (or at least every 15 s under a steady trickle, which a test
 * cannot wait for) — and a bounded memory map for reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs";
import { pathToFileURL } from "node:url";

import { AccountDb } from "../dist/db/index.js";
import { sqlite } from "../dist/db/sqlite.js";
import { PEER, T0, openTemp, textMessage } from "./db-fixtures.mjs";
import { waitFor } from "./helpers.mjs";

/** The messages the database file itself holds, the log left unread. */
function inFile(path) {
  const reader = new (sqlite().DatabaseSync)(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
  try {
    return reader.prepare("SELECT count(*) AS n FROM messages").get().n;
  } finally {
    reader.close();
  }
}

const pragma = (db, name) => Object.values(db.connection.db.prepare(`PRAGMA ${name}`).get())[0];

test("writes gone quiet are checkpointed into the database file by a timer, not by a commit", async () => {
  const { db, path } = openTemp({ idleCheckpointMs: 30 });
  try {
    assert.equal(pragma(db, "wal_autocheckpoint"), 10_000, "commits only checkpoint past the backstop");
    // A new file's schema is itself still in the log.
    db.checkpoint();
    db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
    db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "ce faci"));
    assert.equal(inFile(path), 0, "the commits left their pages in the log");
    await waitFor(() => inFile(path) === 2, 3000, "the idle checkpoint");
    // Reads still see everything, and later writes arm the timer again.
    db.messages.upsert(textMessage(PEER, "C", T0 + 2000, "bine"));
    await waitFor(() => inFile(path) === 3, 3000, "the next idle checkpoint");
    assert.equal(db.messages.chatPage(PEER, { limit: 10 }).items.length, 3);
  } finally {
    db.close();
  }
});

test("a chunked operation keeps SQLite's own 1,000 pages while it runs, so no chunk's commit copies 10,000", async () => {
  const { db } = openTemp();
  try {
    const seen = [];
    let steps = 0;
    const both = Promise.all([
      db.connection.chunked(() => {
        seen.push(pragma(db, "wal_autocheckpoint"));
        return ++steps < 3;
      }),
      db.connection.chunked(() => {
        seen.push(pragma(db, "wal_autocheckpoint"));
        return false;
      }),
    ]);
    await both;
    assert.deepEqual([...new Set(seen)], [1000], "every chunk, the overlapping one too");
    assert.equal(pragma(db, "wal_autocheckpoint"), 10_000, "back to the backstop once the last one ends");
    await assert.rejects(db.connection.chunked(() => {
      throw new Error("a chunk that fails");
    }));
    assert.equal(pragma(db, "wal_autocheckpoint"), 10_000, "and after one that failed");
  } finally {
    db.close();
  }
});

/**
 * Under the lowered threshold, the first chunk's commit would fold whatever
 * the log held when the operation began (up to the ~40 MB backstop after a
 * burst) inside that commit. The backlog is folded first, in a turn of its
 * own, so no step pauses for both.
 */
test("a chunked operation folds what the log already holds before its first chunk, in a turn of its own", async () => {
  const { db, path } = openTemp({ idleCheckpointMs: 60_000 });
  try {
    db.checkpoint();
    db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
    db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "ce faci"));
    assert.equal(inFile(path), 0, "the commits left their pages in the log, the idle checkpoint a minute away");
    const seen = [];
    let turned = false;
    setImmediate(() => (turned = true));
    await db.connection.chunked(() => {
      seen.push({ inFile: inFile(path), turned });
      return seen.length < 2;
    });
    assert.deepEqual(seen[0], { inFile: 2, turned: true }, "folded, and the event loop ran, before the first chunk");
    // Nothing left to fold: the next one starts at once.
    db.checkpoint();
    let later;
    turned = false;
    setImmediate(() => (turned = true));
    await db.connection.chunked(() => {
      later ??= turned;
      return false;
    });
    assert.equal(later, false);
  } finally {
    db.close();
  }
});

/**
 * A clear or a delete starts from a socket's callback (the chat's change
 * answered on the WebSocket), in the loop's I/O phase. One setImmediate from
 * there fires in the check phase right after it, with no I/O between the fold
 * and the first chunk: a frame or a request waited for both. The loop comes
 * round, timers and I/O, before the first chunk wherever the caller started.
 */
test("the turn after the fold lets the loop come round even when the operation starts from an I/O callback", async () => {
  const { db, path } = openTemp({ idleCheckpointMs: 60_000 });
  try {
    db.checkpoint();
    db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
    const seen = [];
    await new Promise((resolve, reject) => {
      // A file stat's callback runs in the I/O phase, as a socket's does.
      stat(path, () => {
        let timer = false;
        setTimeout(() => (timer = true), 0);
        // The timer is due before the fold begins.
        const until = performance.now() + 3;
        while (performance.now() < until);
        db.connection
          .chunked(() => {
            seen.push({ inFile: inFile(path), timer });
            return false;
          })
          .then(resolve, reject);
      });
    });
    assert.deepEqual(seen, [{ inFile: 1, timer: true }], "folded, and the loop came round, before the first chunk");
  } finally {
    db.close();
  }
});

test("idleCheckpointMs 0 leaves checkpoints to SQLite, inside the commit, as before", () => {
  const { db } = openTemp({ idleCheckpointMs: 0 });
  try {
    assert.equal(pragma(db, "wal_autocheckpoint"), 1000);
    assert.equal(pragma(db, "journal_size_limit"), -1);
  } finally {
    db.close();
  }
});

test("the writable connection reads the file through a bounded memory map; a read-only one does not", () => {
  const { db, path } = openTemp();
  try {
    assert.equal(pragma(db, "mmap_size"), 256 * 1024 * 1024);
    db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
    assert.equal(db.messages.chatPage(PEER, { limit: 10 }).items.length, 1);
  } finally {
    db.close();
  }
  const ro = AccountDb.open(path, { readOnly: true });
  try {
    assert.equal(pragma(ro, "mmap_size"), 0);
  } finally {
    ro.close();
  }
});

test("a read-only open sets none of it", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "salut"));
  db.close();
  const ro = AccountDb.open(path, { readOnly: true });
  try {
    assert.equal(pragma(ro, "wal_autocheckpoint"), 1000);
    assert.equal(ro.messages.chatPage(PEER, { limit: 10 }).items.length, 1);
  } finally {
    ro.close();
  }
});
