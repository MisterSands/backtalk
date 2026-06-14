/**
 * lib/lines.js — call → line context resolution and per-line config profiles.
 *
 * Two concerns, both opt-in and both read-only against the Quo API:
 *
 *   1. Call context: GET /calls/{id} gives the phoneNumberId of the line the
 *      call happened on and the userId of the workspace member who handled
 *      it. Used for ASSIGN_MODE=call-user (assign the task to the rep who was
 *      actually on the call) and for per-line config lookup. One GET per
 *      call, cached.
 *
 *   2. Line directory: GET /phone-numbers gives id → {name, number} for every
 *      line in the workspace, so per-line config can be keyed by the friendly
 *      E.164 number instead of an opaque PN... id. Cached for 5 minutes.
 *
 * Per-line config (LINE_CONFIG env var) is a JSON object keyed by E.164
 * number or phoneNumberId:
 *
 *   {
 *     "+15555550100": { "skip": true },
 *     "+15555550101": { "minConfidence": "low", "assignee": "US...",
 *                        "includeCallerCommitments": true, "maxTasksPerCall": 4 }
 *   }
 *
 * Unknown keys inside a profile are ignored; values are whitelisted here so a
 * typo'd profile can never weaken validation elsewhere.
 */

const CONFIDENCE_VALUES = ["low", "medium", "high"];

/** Parse and whitelist LINE_CONFIG. Returns {} on missing/invalid JSON. */
export function parseLineConfig(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { __error: "LINE_CONFIG is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { __error: "LINE_CONFIG must be a JSON object" };
  }
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const profile = {};
    if (value.skip === true) profile.skip = true;
    if (CONFIDENCE_VALUES.includes(value.minConfidence)) profile.minConfidence = value.minConfidence;
    if (typeof value.assignee === "string" && value.assignee) profile.assignee = value.assignee;
    if (typeof value.includeCallerCommitments === "boolean") {
      profile.includeCallerCommitments = value.includeCallerCommitments;
    }
    const cap = Number(value.maxTasksPerCall);
    if (Number.isFinite(cap) && cap >= 1) profile.maxTasksPerCall = Math.min(Math.floor(cap), 8);
    out[key.trim()] = profile;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.quo Quo client from createQuoClient (or null).
 */
export function createLineResolver({ quo } = {}) {
  let lineCache = { at: 0, byId: new Map(), byNumber: new Map() };
  const callCache = new Map(); // callId → {at, ctx}

  async function lines() {
    if (Date.now() - lineCache.at < 5 * 60000 && lineCache.byId.size) return lineCache;
    if (!quo) return lineCache;
    const r = await quo.listPhoneNumbers();
    if (r.ok && Array.isArray(r.data?.data)) {
      const byId = new Map();
      const byNumber = new Map();
      for (const p of r.data.data) {
        if (!p?.id) continue;
        const info = { id: p.id, name: p.name || p.number || p.id, number: p.number || null };
        byId.set(p.id, info);
        if (p.number) byNumber.set(p.number, info);
      }
      lineCache = { at: Date.now(), byId, byNumber };
    }
    return lineCache;
  }

  /**
   * Resolve {phoneNumberId, lineName, lineNumber, userId} for a call.
   * Returns nulls on any failure — callers treat context as best-effort.
   */
  async function callContext(callId) {
    const hit = callCache.get(callId);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.ctx;
    let ctx = {
      phoneNumberId: null,
      lineName: null,
      lineNumber: null,
      userId: null,
      direction: null,
      createdAt: null,
      participants: [],
    };
    if (quo && callId) {
      const r = await quo.getCall(callId);
      const c = r.ok ? (r.data?.data ?? r.data ?? {}) : {};
      ctx.phoneNumberId = typeof c.phoneNumberId === "string" ? c.phoneNumberId : null;
      ctx.userId = typeof c.userId === "string" ? c.userId : null;
      ctx.direction = typeof c.direction === "string" ? c.direction : null;
      ctx.createdAt = typeof c.createdAt === "string" ? c.createdAt : null;
      ctx.participants = Array.isArray(c.participants) ? c.participants : [];
      if (ctx.phoneNumberId) {
        const dir = await lines();
        const info = dir.byId.get(ctx.phoneNumberId);
        if (info) {
          ctx.lineName = info.name;
          ctx.lineNumber = info.number;
        }
      }
    }
    callCache.set(callId, { at: Date.now(), ctx });
    if (callCache.size > 1000) callCache.delete(callCache.keys().next().value);
    return ctx;
  }

  /** Look up the per-line profile for a resolved call context. */
  function profileFor(lineConfig, ctx) {
    if (!lineConfig || !ctx) return null;
    return (
      (ctx.lineNumber && lineConfig[ctx.lineNumber]) ||
      (ctx.phoneNumberId && lineConfig[ctx.phoneNumberId]) ||
      null
    );
  }

  return { lines, callContext, profileFor };
}
