#!/usr/bin/env node
/**
 * backfill.mjs — replay recent calls through a RUNNING BackTalk server.
 *
 * "I installed BackTalk today — what about yesterday's calls?" This answers
 * that. It discovers recent completed calls via the Quo API (read-only),
 * then POSTs each call id to the server's /replay endpoint, which runs the
 * normal pipeline: transcript fetch → LLM extraction → validation → tasks.
 * Everything that protects the live path protects this one too — the
 * idempotency store and the `Source: backtalk ref:` marker dedupe make
 * re-runs safe; calls that already produced tasks are skipped.
 *
 * Usage:
 *   REPLAY_TOKEN must be set on the server (enables /replay) and available
 *   here (env or .env in the cwd). QUO_API_KEY likewise.
 *
 *   node backfill.mjs                       # last 7 days, dry list first? no — replays
 *   node backfill.mjs --since 3d            # last 3 days
 *   node backfill.mjs --since 2026-06-01    # since a date
 *   node backfill.mjs --dry-run             # only list what would be replayed
 *   node backfill.mjs --max 20              # cap replays this run
 *   node backfill.mjs --server https://my-host.example   # remote server
 *
 * Discovery notes: the Quo list-calls endpoint requires BOTH a phoneNumberId
 * and a participant, so discovery walks conversations first (they carry the
 * participant pairs), then lists calls per (line, participant). Bounded:
 * max 5 conversation pages (500 conversations) per run.
 */

import fs from "node:fs";
import path from "node:path";
import { createQuoClient } from "./lib/quo.js";

// ---------------------------------------------------------------- env/args

function loadDotEnv(file = path.join(process.cwd(), ".env")) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

function parseArgs(argv) {
  const args = { since: "7d", server: "http://localhost:8787", max: 50, dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--server") args.server = argv[++i];
    else if (a === "--max") args.max = Number(argv[++i]) || args.max;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node backfill.mjs [--since 7d|YYYY-MM-DD] [--server URL] [--max N] [--dry-run] [--force]");
      process.exit(0);
    }
  }
  return args;
}

function sinceIso(spec) {
  const rel = /^(\d+)d$/.exec(String(spec ?? ""));
  if (rel) return new Date(Date.now() - Number(rel[1]) * 86400000).toISOString();
  const ms = Date.parse(spec);
  if (!Number.isFinite(ms)) {
    console.error(`bad --since value: ${spec} (use 7d or an ISO date)`);
    process.exit(1);
  }
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv);
const SINCE = sinceIso(args.since);
const QUO_API_KEY = process.env.QUO_API_KEY;
const REPLAY_TOKEN = process.env.REPLAY_TOKEN;

if (!QUO_API_KEY) {
  console.error("QUO_API_KEY is required (env or .env)");
  process.exit(1);
}
if (!REPLAY_TOKEN && !args.dryRun) {
  console.error("REPLAY_TOKEN is required (env or .env) — set it on the server too, it enables POST /replay");
  process.exit(1);
}

const quo = createQuoClient({ apiKey: QUO_API_KEY, userAgent: "backtalk-backfill/0.1" });

async function discoverCalls() {
  const callIds = new Map(); // id → {createdAt}
  let pageToken = null;
  for (let page = 0; page < 5; page++) {
    const conv = await quo.listConversations({ createdAfter: SINCE, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    if (!conv.ok) {
      console.error(`conversation list failed: ${conv.status} ${conv.error}`);
      break;
    }
    const conversations = conv.data?.data ?? [];
    for (const c of conversations) {
      const phoneNumberId = c?.phoneNumberId;
      const participants = Array.isArray(c?.participants) ? c.participants : [];
      if (!phoneNumberId || participants.length === 0) continue;
      for (const participant of participants) {
        const calls = await quo.listCalls({ phoneNumberId, participants: participant, createdAfter: SINCE, maxResults: 100 });
        if (!calls.ok) continue;
        for (const call of calls.data?.data ?? []) {
          if (!call?.id) continue;
          if (call.status && call.status !== "completed") continue;
          callIds.set(call.id, { createdAt: call.createdAt ?? null });
        }
      }
    }
    pageToken = conv.data?.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return [...callIds.entries()]
    .sort((a, b) => String(a[1].createdAt ?? "").localeCompare(String(b[1].createdAt ?? "")))
    .map(([id, meta]) => ({ id, ...meta }));
}

async function replay(callId) {
  try {
    const res = await fetch(`${args.server.replace(/\/+$/, "")}/replay`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-replay-token": REPLAY_TOKEN },
      body: JSON.stringify({ callId, force: args.force }),
      signal: AbortSignal.timeout(120000), // LLM extraction can take a while
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (err) {
    return { status: 0, body: { error: String(err) } };
  }
}

console.log(`Discovering completed calls since ${SINCE} ...`);
const calls = await discoverCalls();
console.log(`Found ${calls.length} call(s).`);

if (args.dryRun) {
  for (const c of calls) console.log(`  would replay ${c.id}  (${c.createdAt ?? "?"})`);
  console.log("\n--dry-run: nothing sent. Drop the flag to replay through the server.");
  process.exit(0);
}

let sent = 0;
const totals = { created: 0, duplicates: 0, skipped: 0, pending: 0, failed: 0 };
for (const c of calls) {
  if (sent >= args.max) {
    console.log(`--max ${args.max} reached; run again to continue.`);
    break;
  }
  sent += 1;
  const r = await replay(c.id);
  const b = r.body ?? {};
  if (r.status === 200 && b.duplicate) {
    totals.duplicates += 1;
    console.log(`  ${c.id}  already processed`);
  } else if (r.status === 200 && b.pending) {
    totals.pending += 1;
    console.log(`  ${c.id}  transcript ${b.status} — nothing to do`);
  } else if (r.status === 200 && b.skipped) {
    totals.skipped += 1;
    console.log(`  ${c.id}  skipped (${b.skipped})`);
  } else if (r.status === 200) {
    totals.created += Number(b.created) || 0;
    console.log(`  ${c.id}  extracted ${b.extracted ?? 0}, created ${b.created ?? 0}, duplicates ${b.duplicates ?? 0}`);
  } else {
    totals.failed += 1;
    console.log(`  ${c.id}  FAILED ${r.status} ${b.error ?? ""}`);
  }
}

console.log(
  `\nDone. tasks created: ${totals.created} · already processed: ${totals.duplicates} · ` +
    `skipped: ${totals.skipped} · no transcript: ${totals.pending} · failed: ${totals.failed}`,
);
