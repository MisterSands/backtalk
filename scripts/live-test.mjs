#!/usr/bin/env node
/**
 * scripts/live-test.mjs — GET-ONLY smoke test against a real account.
 *
 * This script NEVER writes to the Quo API. A hard guard wrapped around
 * global fetch throws on any non-GET request to api.openphone.com. The task
 * payloads it builds are PRINTED, never sent. (Calls to your configured LLM
 * provider are allowed — they are not the Quo API.)
 *
 * Usage:
 *   node scripts/live-test.mjs                         GET /v1/tasks?maxResults=1
 *   node scripts/live-test.mjs <callId>                + GET /v1/call-transcripts/<callId> + LLM extraction
 *   node scripts/live-test.mjs --fixture <path.json>   offline: transcript from a fixture file, ZERO Quo calls
 *
 * Env (from .env or the environment): QUO_API_KEY (online modes),
 * LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL for extraction.
 * DEBUG=1 prints the would-be task payloads; default output is counts only.
 */

import fs from "node:fs";
import path from "node:path";
import { createQuoClient } from "../lib/quo.js";
import {
  flattenTranscript,
  capTranscript,
  buildSystemPrompt,
  buildUserMessage,
  parseAndValidate,
  buildTaskPayload,
} from "../lib/extract.js";
import { chatJson } from "../lib/llm.js";

// ---------- guard: not a unit test ----------
// A bare `node --test` (without npm test's "test/*.test.js" scope) auto-discovers
// this file via the *-test.mjs pattern and runs it as a child-process entry point,
// where a missing QUO_API_KEY would register as a spurious test failure. The test
// runner sets NODE_TEST_CONTEXT in its children — detect it and no-op cleanly.
// The canonical commands are `npm test` (unit tests) and `node scripts/live-test.mjs` (this script).
if (process.env.NODE_TEST_CONTEXT) {
  process.exit(0);
}

// ---------- .env (never overrides already-set vars) ----------
try {
  const envText = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // no .env — env vars may come from the shell
}

// ---------- HARD GUARD: refuse any non-GET request to the Quo API ----------
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? "");
  const method = String(
    init.method ?? (typeof input === "object" && input !== null ? input.method : undefined) ?? "GET",
  ).toUpperCase();
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // relative URLs cannot reach the Quo API
  }
  if ((host === "api.openphone.com" || host.endsWith(".openphone.com")) && method !== "GET") {
    throw new Error(`BLOCKED: non-GET ${method} to ${host} — live-test is strictly read-only against the Quo API`);
  }
  return realFetch(input, init);
};

const DEBUG = process.env.DEBUG === "1";
const out = (...args) => console.log(...args);
const die = (msg) => {
  console.error(`[live-test] ERROR: ${msg}`);
  process.exit(1);
};

// ---------- args ----------
const args = process.argv.slice(2);
let fixturePath = null;
let callId = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fixture") {
    fixturePath = args[i + 1] ?? null;
    i += 1;
  } else if (!callId) {
    callId = args[i];
  }
}
if (callId && callId.toLowerCase().endsWith(".json")) {
  fixturePath = callId;
  callId = null;
}

// ---------- stage 1: transcript acquire ----------
let transcript = null;

if (fixturePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  } catch (err) {
    die(`could not read fixture ${fixturePath}: ${String(err)}`);
  }
  transcript = parsed?.data ?? parsed;
  out(`[live-test] fixture transcript loaded from ${fixturePath} — fixture mode makes ZERO Quo API calls`);
} else {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) die("QUO_API_KEY is not set (or pass --fixture <path> for offline mode)");
  const quo = createQuoClient({ apiKey });

  const tasks = await quo.listTasks({ maxResults: 1 });
  if (!tasks.ok) die(`GET /v1/tasks?maxResults=1 failed: HTTP ${tasks.status} ${tasks.error}`);
  out(`[live-test] GET /v1/tasks?maxResults=1 -> ${tasks.status} (totalItems: ${tasks.data?.totalItems ?? "n/a"})`);

  if (callId) {
    const tr = await quo.getTranscript(callId);
    if (!tr.ok) {
      out(`[live-test] GET /v1/call-transcripts/${callId} -> HTTP ${tr.status} (404 means no transcript exists for that call — normal)`);
    } else {
      transcript = tr.data?.data ?? null;
      out(`[live-test] transcript fetched: status=${transcript?.status} turns=${transcript?.dialogue?.length ?? 0}`);
    }
  }
}

if (!transcript) {
  out("[live-test] no transcript to extract from — done. GET-only guard held for the whole run.");
  process.exit(0);
}
if (transcript.status !== "completed" || !Array.isArray(transcript.dialogue) || transcript.dialogue.length === 0) {
  out(`[live-test] transcript not usable (status=${transcript.status ?? "unknown"}) — done.`);
  process.exit(0);
}

// ---------- stage 2: LLM extraction ----------
const llmApiKey = process.env.LLM_API_KEY;
const llmModel = process.env.LLM_MODEL;
if (!llmApiKey || !llmModel) {
  out("[live-test] LLM_API_KEY / LLM_MODEL not set — skipping extraction. Done.");
  process.exit(0);
}

const flat = flattenTranscript(transcript.dialogue);
const capped = capTranscript(flat, Number(process.env.MAX_TRANSCRIPT_CHARS) || 24000);
const callDateIso =
  typeof transcript.createdAt === "string" && transcript.createdAt ? transcript.createdAt : new Date().toISOString();
const userMessage = buildUserMessage(
  {
    direction: typeof transcript.direction === "string" ? transcript.direction : "unknown",
    durationSeconds: Math.round(Number(transcript.duration) || 0),
    callDateIso,
    timezone: process.env.TIMEZONE || "UTC",
  },
  capped,
);

const provider = process.env.LLM_PROVIDER || "openai";
out(`[live-test] calling LLM (provider=${provider}, model=${llmModel}) ...`);
const llm = await chatJson({
  provider,
  baseUrl: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: llmApiKey,
  model: llmModel,
  system: buildSystemPrompt(),
  user: userMessage,
});
if (!llm.ok) die(`LLM call failed: ${llm.error}`);

const result = parseAndValidate(llm.text, {
  transcriptFlat: capped,
  callDateIso,
  includeCaller: process.env.INCLUDE_CALLER_COMMITMENTS === "1",
  maxTasks: Math.min(Number(process.env.MAX_TASKS_PER_CALL) || 8, 8),
  minConfidence: ["low", "medium", "high"].includes(process.env.MIN_CONFIDENCE)
    ? process.env.MIN_CONFIDENCE
    : "medium",
});
if (!result.ok) die(`LLM output failed Layer-2 validation: ${result.error}`);

// ---------- stage 3: print (never send) the would-be task payloads ----------
const sourceCallId = typeof transcript.callId === "string" && transcript.callId ? transcript.callId : "ACunknown";
const payloads = result.commitments.map((c, i) =>
  buildTaskPayload(c, { callId: sourceCallId, index: i + 1, assignedTo: process.env.QUO_DEFAULT_ASSIGNEE || null }),
);
const droppedItems = result.audit.filter((a) => a.dropped).length;

out(
  `[live-test] extraction summary: surviving=${result.commitments.length} droppedItems=${droppedItems} auditEntries=${result.audit.length}`,
);
if (DEBUG) {
  out("[live-test] would-be task payloads (NOT sent — this script never POSTs to api.openphone.com):");
  out(JSON.stringify(payloads, null, 2));
  out(`[live-test] call_summary: ${result.callSummary}`);
  out(`[live-test] audit: ${JSON.stringify(result.audit)}`);
} else {
  out("[live-test] set DEBUG=1 to print the would-be task payloads (they are never sent either way).");
}
out("[live-test] OK — zero write calls were made to the Quo API.");
