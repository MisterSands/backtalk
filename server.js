#!/usr/bin/env node
/**
 * TalkBack — webhook server.
 *
 * Four stages, nothing else:
 *   [webhook receive + verify] → [transcript acquire] → [LLM promise extraction] → [Quo task creation]
 *
 * Stateless pass-through by default: no transcript persisted, no PII stored.
 * The only state is an idempotency set of call ids (in-memory LRU, optional
 * JSON file). Zero runtime dependencies — Node >= 20 built-ins only.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { verifyWebhook } from "./lib/verify.js";
import { createQuoClient } from "./lib/quo.js";
import {
  flattenTranscript,
  capTranscript,
  buildSystemPrompt,
  buildUserMessage,
  parseAndValidate,
  buildTaskPayload,
} from "./lib/extract.js";
import { chatJson } from "./lib/llm.js";

// ---------------------------------------------------------------- logging

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

function debug(msg, extra = {}) {
  if (cfg.debug) log("debug", msg, extra);
}

// ---------------------------------------------------------------- env

function loadDotEnv(file = path.join(process.cwd(), ".env")) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env — fine, env vars may come from the host
  }
  for (const rawLine of text.split(/\r?\n/)) {
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
}
loadDotEnv();

const env = process.env;
const flag = (v) => String(v ?? "").trim() === "1";
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function parseOwnedNumbers(raw) {
  // "+15555550100=Alex Agent,+15555550101=Bailey Agent" → Set of E.164 numbers.
  const set = new Set();
  for (const part of String(raw ?? "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const number = item.split("=")[0].trim();
    if (number) set.add(number);
  }
  return set;
}

const cfg = {
  quoApiKey: env.QUO_API_KEY ?? "",
  webhookSecrets: String(env.QUO_WEBHOOK_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  llmProvider: env.LLM_PROVIDER || "openai",
  llmBaseUrl: env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  llmApiKey: env.LLM_API_KEY ?? "",
  llmModel: env.LLM_MODEL ?? "",
  llmFallbackModel: env.LLM_FALLBACK_MODEL || null,
  includeCaller: flag(env.INCLUDE_CALLER_COMMITMENTS),
  minCallSeconds: num(env.MIN_CALL_SECONDS, 30),
  maxTasksPerCall: Math.min(num(env.MAX_TASKS_PER_CALL, 8), 8), // hard ceiling 8
  maxTranscriptChars: num(env.MAX_TRANSCRIPT_CHARS, 24000),
  minConfidence: ["low", "medium", "high"].includes(env.MIN_CONFIDENCE) ? env.MIN_CONFIDENCE : "medium",
  ownedNumbers: parseOwnedNumbers(env.OWNED_NUMBERS),
  defaultAssignee: env.QUO_DEFAULT_ASSIGNEE || null,
  timezone: env.TIMEZONE || "UTC",
  port: num(env.PORT, 8787),
  debug: flag(env.DEBUG),
  dryRun: flag(env.DRY_RUN),
  idempotencyFile: env.IDEMPOTENCY_FILE || null,
  idempotencyMax: num(env.IDEMPOTENCY_MAX, 5000),
  skewSeconds: num(env.SIGNATURE_SKEW_SECONDS, 300),
  allowUnsigned: flag(env.ALLOW_UNSIGNED),
  fallbackPoll: flag(env.FALLBACK_POLL),
  replayToken: env.REPLAY_TOKEN || null,
};

const bootErrors = [];
if (!cfg.llmApiKey) bootErrors.push("LLM_API_KEY is required");
if (!cfg.llmModel) bootErrors.push("LLM_MODEL is required");
if (!cfg.quoApiKey && !cfg.dryRun) {
  bootErrors.push("QUO_API_KEY is required (or set DRY_RUN=1 for log-only mode)");
}
if (cfg.webhookSecrets.length === 0 && !cfg.allowUnsigned) {
  bootErrors.push("QUO_WEBHOOK_SECRET is required (or ALLOW_UNSIGNED=1 for local dev only)");
}
if (bootErrors.length > 0) {
  for (const e of bootErrors) log("error", `config: ${e}`);
  process.exit(1);
}

// ---------------------------------------------------------------- idempotency

/**
 * Call-id claim store. Lifecycle: pending → processing → done | failed | skipped.
 * Holds {callId, status, ts} ONLY — no PII. Optional JSON file persists across
 * restarts; rewritten atomically (tmp + rename).
 */
class IdempotencyStore {
  constructor({ max = 5000, file = null } = {}) {
    this.max = max;
    this.file = file;
    this.map = new Map();
    if (file) this.#load();
  }

  #load() {
    try {
      const entries = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e && typeof e.callId === "string") this.map.set(e.callId, { status: e.status, ts: e.ts });
        }
      }
    } catch {
      // missing/corrupt file → start empty
    }
  }

  get(callId) {
    const entry = this.map.get(callId);
    return entry ? entry.status : undefined;
  }

  set(callId, status) {
    if (this.map.has(callId)) this.map.delete(callId); // refresh LRU position
    this.map.set(callId, { status, ts: Date.now() });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value); // evict oldest
    }
    this.#persist();
  }

  #persist() {
    if (!this.file) return;
    try {
      const entries = [...this.map.entries()].map(([callId, e]) => ({ callId, status: e.status, ts: e.ts }));
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log("warn", "idempotency file write failed", { error: String(err) });
    }
  }
}

const store = new IdempotencyStore({ max: cfg.idempotencyMax, file: cfg.idempotencyFile });
const quo = cfg.quoApiKey ? createQuoClient({ apiKey: cfg.quoApiKey }) : null;

// ---------------------------------------------------------------- helpers

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** First external speaker's E.164 — used only for the conversationId fallback linkage. */
function externalE164(dialogue) {
  for (const turn of Array.isArray(dialogue) ? dialogue : []) {
    if (turn && turn.identifier && !turn.userId && !cfg.ownedNumbers.has(turn.identifier)) {
      return turn.identifier;
    }
  }
  return null;
}

// ---------------------------------------------------------------- LLM step

async function runExtraction(systemPrompt, userMessage, validateCtx) {
  const models = [cfg.llmModel];
  if (cfg.llmFallbackModel) models.push(cfg.llmFallbackModel); // config only — never from input
  let lastError = "llm extraction failed";
  for (const model of models) {
    const r = await chatJson({
      provider: cfg.llmProvider,
      baseUrl: cfg.llmBaseUrl,
      apiKey: cfg.llmApiKey,
      model,
      system: systemPrompt,
      user: userMessage,
    });
    if (!r.ok || !r.text) {
      lastError = r.error ?? "empty response";
      log("warn", "llm attempt failed", { model, error: lastError });
      continue;
    }
    const parsed = parseAndValidate(r.text, validateCtx);
    if (parsed.ok) return { ok: true, parsed, model };
    lastError = parsed.error;
    log("warn", "llm output failed validation", { model, error: lastError });
  }
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------- task creation

async function createTasks(commitments, { callId, callerE164 }) {
  let created = 0;
  let logged = 0;
  let duplicates = 0;
  if (commitments.length === 0) return { created, logged, duplicates, transient: false };

  // DRY_RUN (or no API key) → log-only mode: print exact intended payloads.
  if (cfg.dryRun || !quo) {
    commitments.forEach((commitment, i) => {
      const payload = buildTaskPayload(commitment, { callId, index: i + 1, assignedTo: cfg.defaultAssignee });
      log("info", "[DRY_RUN] would create task", { payload });
      logged += 1;
    });
    return { created, logged, duplicates, transient: false };
  }

  // Effect-level dedupe (best effort, first page only) — survives store loss.
  let existingDescriptions = [];
  const listed = await quo.listTasks({ maxResults: 100 });
  if (listed.ok && Array.isArray(listed.data?.data)) {
    existingDescriptions = listed.data.data.map((t) => String(t?.description ?? ""));
  } else {
    log("warn", "task list for dedupe failed (continuing without it)", { status: listed.status });
  }

  let logOnly = false;
  let conversationId = null; // null = not tried; undefined = tried and failed
  for (let i = 0; i < commitments.length; i++) {
    const marker = `ref:${callId}/${i + 1}`;
    if (existingDescriptions.some((d) => d.includes(marker))) {
      duplicates += 1;
      continue;
    }
    const payload = buildTaskPayload(commitments[i], { callId, index: i + 1, assignedTo: cfg.defaultAssignee });

    if (logOnly) {
      log("warn", "FALLBACK:LOG_ONLY task payload", { payload });
      logged += 1;
      continue;
    }

    let r = await quo.createTask(payload);

    // Graceful linkage fallback: 400 mentioning the linkage field → retry once
    // with conversationId resolved from the caller's E.164.
    if (!r.ok && r.status === 400 && /activit|conversation|phone|link|exactly one/i.test(String(r.error))) {
      if (conversationId === null && callerE164) {
        const resolved = await quo.resolveConversationId(callerE164);
        conversationId = resolved.ok && resolved.conversationId ? resolved.conversationId : undefined;
      }
      if (conversationId) {
        const alt = { ...payload };
        delete alt.activityId;
        alt.conversationId = conversationId;
        r = await quo.createTask(alt);
      }
    }

    if (r.ok) {
      created += 1;
      continue;
    }
    if (r.status >= 500 || r.status === 429 || r.status === 0) {
      log("error", "task create transient failure", { callId, status: r.status, error: r.error });
      return { created, logged, duplicates, transient: true };
    }
    // Persistent 4xx → degrade to log-only for the rest of this delivery.
    logOnly = true;
    log("warn", "FALLBACK:LOG_ONLY task payload", { status: r.status, error: r.error, payload });
    logged += 1;
  }
  return { created, logged, duplicates, transient: false };
}

// ---------------------------------------------------------------- pipeline

async function processTranscript(transcriptObj, { force = false } = {}) {
  const t = transcriptObj ?? {};
  const callId = typeof t.callId === "string" && t.callId ? t.callId : null;
  if (!callId) return { code: 200, body: { ok: true, skipped: "no_call_id" } };

  const dialogue = Array.isArray(t.dialogue) ? t.dialogue : null;
  if (t.status !== "completed") {
    return { code: 200, body: { ok: true, callId, skipped: `transcript_status:${t.status ?? "unknown"}` } };
  }
  if (!dialogue || dialogue.length === 0) {
    return { code: 200, body: { ok: true, callId, skipped: "empty_transcript" } };
  }

  // Idempotency claim: absent/pending → claim; failed → re-claim;
  // processing|done|skipped → duplicate ack.
  if (!force) {
    const existing = store.get(callId);
    if (existing && existing !== "failed" && existing !== "pending") {
      return { code: 200, body: { ok: true, callId, duplicate: true } };
    }
  }
  store.set(callId, "processing");

  // Guards before any LLM spend.
  const duration = Math.round(Number(t.duration) || 0);
  if (duration < cfg.minCallSeconds) {
    store.set(callId, "skipped");
    return { code: 200, body: { ok: true, callId, skipped: "too_short", duration } };
  }
  const transcriptFlat = flattenTranscript(dialogue, { ownedNumbers: cfg.ownedNumbers });
  if (!transcriptFlat) {
    store.set(callId, "skipped");
    return { code: 200, body: { ok: true, callId, skipped: "empty_transcript" } };
  }
  const capped = capTranscript(transcriptFlat, cfg.maxTranscriptChars);
  debug("flattened transcript", { callId, chars: transcriptFlat.length, transcript: capped }); // text only under DEBUG=1

  const callDateIso = typeof t.createdAt === "string" && t.createdAt ? t.createdAt : new Date().toISOString();
  const userMessage = buildUserMessage(
    {
      direction: typeof t.direction === "string" ? t.direction : "unknown",
      durationSeconds: duration,
      callDateIso,
      timezone: cfg.timezone,
    },
    capped,
  );

  const extraction = await runExtraction(buildSystemPrompt(), userMessage, {
    transcriptFlat: capped,
    callDateIso,
    includeCaller: cfg.includeCaller,
    maxTasks: cfg.maxTasksPerCall,
    minConfidence: cfg.minConfidence,
  });
  if (!extraction.ok) {
    store.set(callId, "failed"); // provider redelivery will re-claim
    log("error", "llm extraction failed", { callId, error: extraction.error });
    return { code: 500, body: { ok: false, callId, error: "llm" } };
  }

  const { commitments, audit } = extraction.parsed;
  const droppedItems = audit.filter((a) => a.dropped).length;
  log("info", "extraction complete", {
    callId,
    model: extraction.model,
    extracted: commitments.length,
    dropped: droppedItems,
    auditReasons: audit.map((a) => a.reason),
  });
  debug("validation audit", { callId, audit });

  const result = await createTasks(commitments, { callId, callerE164: externalE164(dialogue) });
  if (result.transient) {
    store.set(callId, "failed");
    return { code: 500, body: { ok: false, callId, error: "task_create" } };
  }

  store.set(callId, "done");
  return {
    code: 200,
    body: {
      ok: true,
      callId,
      extracted: commitments.length,
      created: result.created,
      logged: result.logged,
      duplicates: result.duplicates,
      dropped: droppedItems,
    },
  };
}

// ---------------------------------------------------------------- fallback poll

const POLL_DELAYS_MS = [30000, 60000, 120000, 240000, 480000]; // ~15.5 min budget

function schedulePoll(callId) {
  const existing = store.get(callId);
  if (existing && existing !== "failed") {
    log("info", "poll not scheduled (call already tracked)", { callId, status: existing });
    return;
  }
  store.set(callId, "pending");
  log("info", "transcript poll scheduled", { callId, attempts: POLL_DELAYS_MS.length });
  attemptPoll(callId, 0);
}

function attemptPoll(callId, attempt) {
  if (attempt >= POLL_DELAYS_MS.length) {
    store.set(callId, "skipped");
    log("info", "poll budget exhausted — no transcript", { callId });
    return;
  }
  setTimeout(async () => {
    try {
      if (!quo) {
        store.set(callId, "skipped");
        log("warn", "poll skipped: no QUO_API_KEY configured", { callId });
        return;
      }
      const r = await quo.getTranscript(callId);
      const status = r.ok ? r.data?.data?.status : r.status === 404 ? "not_found" : "error";
      if (r.ok && status === "completed") {
        const out = await processTranscript(r.data.data);
        log("info", "poll pipeline finished", { callId, code: out.code, ...out.body });
        return;
      }
      if (r.ok && (status === "failed" || status === "absent")) {
        store.set(callId, "skipped");
        log("info", "transcript will not arrive — skipping", { callId, status });
        return;
      }
      // 404 / in-progress / transient error → keep polling.
      attemptPoll(callId, attempt + 1);
    } catch (err) {
      log("warn", "poll attempt error", { callId, error: String(err) });
      attemptPoll(callId, attempt + 1);
    }
  }, POLL_DELAYS_MS[attempt]);
}

// ---------------------------------------------------------------- routes

async function handleWebhook(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return send(res, 413, { ok: false, error: "body too large" });
  }

  // Verify FIRST, on the raw bytes — never process unverified payloads.
  if (cfg.allowUnsigned) {
    console.warn(
      "\x1b[31m[TalkBack] ALLOW_UNSIGNED=1 — signature verification is DISABLED. Local development only.\x1b[0m",
    );
  } else {
    const v = verifyWebhook(raw, req.headers, cfg.webhookSecrets, { skewSeconds: cfg.skewSeconds });
    if (!v.ok) {
      log("warn", "webhook signature rejected", { scheme: v.scheme, reason: v.reason });
      return send(res, 401, { ok: false, error: "signature" });
    }
  }

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return send(res, 400, { ok: false, error: "invalid json" });
  }

  // Tolerant shapes: event object at body.data.object, body.data, or root;
  // type at body.type with body.event fallback.
  const type = body?.type ?? body?.event ?? "unknown";
  const dataObj = body?.data?.object ?? body?.data ?? body;

  if (type === "call.transcript.completed") {
    const out = await processTranscript(dataObj);
    return send(res, out.code, out.body);
  }
  if (type === "call.completed") {
    if (cfg.fallbackPoll) {
      const callId = dataObj?.id ?? dataObj?.callId ?? null;
      if (typeof callId === "string" && callId) {
        schedulePoll(callId);
        return send(res, 200, { ok: true, polling: callId });
      }
      return send(res, 200, { ok: true, ignored: "call.completed (no call id in payload)" });
    }
    return send(res, 200, { ok: true, ignored: "call.completed (subscribe to call.transcript.completed)" });
  }
  return send(res, 200, { ok: true, ignored: String(type) });
}

async function handleReplay(req, res) {
  if (!cfg.replayToken) return send(res, 404, { ok: false, error: "not found" });
  const token = req.headers["x-replay-token"];
  if (!token || !timingSafeStringEqual(token, cfg.replayToken)) {
    return send(res, 401, { ok: false, error: "token" });
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    return send(res, 400, { ok: false, error: "invalid json" });
  }
  const callId = body?.callId;
  const force = body?.force === true;
  if (typeof callId !== "string" || !callId) return send(res, 400, { ok: false, error: "callId required" });
  if (!quo) return send(res, 400, { ok: false, error: "QUO_API_KEY not configured" });

  const r = await quo.getTranscript(callId);
  if (!r.ok && r.status === 404) return send(res, 200, { ok: true, pending: true, status: "absent" });
  if (!r.ok) return send(res, 502, { ok: false, error: "transcript fetch failed", status: r.status });
  const transcript = r.data?.data ?? {};
  if (transcript.status !== "completed") {
    return send(res, 200, { ok: true, pending: true, status: transcript.status ?? "unknown" });
  }
  const out = await processTranscript(transcript, { force });
  return send(res, out.code, out.body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/webhook") return await handleWebhook(req, res);
    if (req.method === "POST" && url.pathname === "/replay") return await handleReplay(req, res);
    return send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    log("error", "unhandled request error", { error: String(err) });
    if (!res.headersSent) send(res, 500, { ok: false, error: "internal" });
  }
});

server.listen(cfg.port, () => {
  log("info", "TalkBack listening", {
    port: cfg.port,
    dryRun: cfg.dryRun,
    allowUnsigned: cfg.allowUnsigned,
    fallbackPoll: cfg.fallbackPoll,
    provider: cfg.llmProvider,
    model: cfg.llmModel,
  });
});
