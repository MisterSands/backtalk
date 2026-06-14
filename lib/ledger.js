/**
 * lib/ledger.js — opt-in local task ledger (NDJSON append-log).
 *
 * OFF by default, preserving BackTalk's stateless posture. When LEDGER_FILE
 * is set, every pipeline outcome is appended as one JSON line so the
 * dashboard, the daily digest, and offline stats can work without re-reading
 * the Quo API. The ledger stores task-level metadata ONLY — the same text
 * that already went to Quo as a task — and NEVER transcripts or dialogue.
 *
 * Events:
 *   call_processed — one per processed call: counts + audit reasons
 *   task_created   — one per task successfully POSTed to Quo
 *   task_logged    — one per task that fell back to log-only (or DRY_RUN)
 *   digest_filed   — one per daily digest task created
 *
 * Append-only, atomic-enough (single appendFileSync per entry, one process).
 * Corrupt lines are skipped on read — the ledger is a convenience cache,
 * never a source of truth (Quo is).
 */

import fs from "node:fs";

export function createLedger({ file } = {}) {
  if (!file) return null;

  function append(event, entry = {}) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), event, ...entry });
      fs.appendFileSync(file, line + "\n");
    } catch {
      // The ledger is best-effort; never let it break the pipeline.
    }
  }

  /**
   * Read entries, newest-last. Optional filters:
   *   sinceMs — only entries with ts >= sinceMs
   *   events  — array of event names to keep
   */
  function read({ sinceMs = 0, events = null } = {}) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // skip corrupt lines
      }
      if (!entry || typeof entry !== "object") continue;
      if (sinceMs && Date.parse(entry.ts) < sinceMs) continue;
      if (events && !events.includes(entry.event)) continue;
      out.push(entry);
    }
    return out;
  }

  /** Aggregate stats for the dashboard/digest over a window. */
  function stats({ sinceMs = 0 } = {}) {
    const entries = read({ sinceMs });
    const s = {
      calls: 0,
      tasksCreated: 0,
      tasksLogged: 0,
      dropped: 0,
      dueSoon: 0, // created tasks due within 48h of now
      dropReasons: {},
    };
    const soonMs = Date.now() + 48 * 3600000;
    for (const e of entries) {
      if (e.event === "call_processed") {
        s.calls += 1;
        s.dropped += Number(e.dropped) || 0;
        for (const reason of Array.isArray(e.auditReasons) ? e.auditReasons : []) {
          s.dropReasons[reason] = (s.dropReasons[reason] || 0) + 1;
        }
      } else if (e.event === "task_created") {
        s.tasksCreated += 1;
        if (e.dueDate) {
          const due = Date.parse(e.dueDate);
          if (Number.isFinite(due) && due <= soonMs && due >= Date.now() - 3600000) s.dueSoon += 1;
        }
      } else if (e.event === "task_logged") {
        s.tasksLogged += 1;
      }
    }
    return s;
  }

  return { file, append, read, stats };
}
