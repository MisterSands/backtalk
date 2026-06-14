import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLedger } from "../lib/ledger.js";

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backtalk-ledger-")), "ledger.ndjson");
}

test("no file configured → ledger is null (stateless default)", () => {
  assert.equal(createLedger({}), null);
  assert.equal(createLedger(), null);
  assert.equal(createLedger({ file: "" }), null);
});

test("append + read round-trips NDJSON entries with ts and event", () => {
  const ledger = createLedger({ file: tmpFile() });
  ledger.append("task_created", { callId: "AC1", title: "Send quote" });
  ledger.append("call_processed", { callId: "AC1", dropped: 2, auditReasons: ["enum", "enum"] });

  const all = ledger.read();
  assert.equal(all.length, 2);
  assert.equal(all[0].event, "task_created");
  assert.equal(all[0].title, "Send quote");
  assert.ok(Number.isFinite(Date.parse(all[0].ts)));

  const filtered = ledger.read({ events: ["call_processed"] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].dropped, 2);
});

test("read filters by sinceMs and skips corrupt lines", () => {
  const file = tmpFile();
  const ledger = createLedger({ file });
  // hand-write an old entry, a corrupt line, and a non-object line
  fs.appendFileSync(file, JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", event: "task_created" }) + "\n");
  fs.appendFileSync(file, "{not json\n");
  fs.appendFileSync(file, "42\n");
  ledger.append("task_created", { callId: "ACnew" });

  assert.equal(ledger.read().length, 2); // corrupt + non-object skipped
  const recent = ledger.read({ sinceMs: Date.now() - 60000 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].callId, "ACnew");
});

test("read on a missing file returns [] instead of throwing", () => {
  const ledger = createLedger({ file: path.join(os.tmpdir(), "backtalk-does-not-exist", "nope.ndjson") });
  assert.deepEqual(ledger.read(), []);
  // append into a missing directory is best-effort and must not throw either
  assert.doesNotThrow(() => ledger.append("task_created", {}));
});

test("stats aggregates calls, tasks, drops, dueSoon", () => {
  const ledger = createLedger({ file: tmpFile() });
  ledger.append("call_processed", { dropped: 1, auditReasons: ["not_grounded"] });
  ledger.append("call_processed", { dropped: 2, auditReasons: ["not_grounded", "enum"] });
  ledger.append("task_created", { dueDate: new Date(Date.now() + 24 * 3600000).toISOString() }); // due soon
  ledger.append("task_created", { dueDate: new Date(Date.now() + 240 * 3600000).toISOString() }); // far out
  ledger.append("task_created", {}); // no due date
  ledger.append("task_logged", {});

  const s = ledger.stats();
  assert.equal(s.calls, 2);
  assert.equal(s.tasksCreated, 3);
  assert.equal(s.tasksLogged, 1);
  assert.equal(s.dropped, 3);
  assert.equal(s.dueSoon, 1);
  assert.deepEqual(s.dropReasons, { not_grounded: 2, enum: 1 });
});
