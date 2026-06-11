/**
 * lib/quo.js — minimal Quo (formerly OpenPhone) API client.
 *
 * Quirks this client encodes:
 *   - Auth header is the RAW key: `Authorization: <apiKey>` — no "Bearer " prefix.
 *   - The API sits behind Cloudflare; a real User-Agent is required (default
 *     library UAs get HTTP 403).
 *   - 404 on GET /call-transcripts/{id} is NORMAL — it means no transcript was
 *     generated for that call, not an error. Callers handle it by status code.
 *
 * Hygiene: every call has a 15s timeout, tolerant JSON parsing of error
 * bodies, 429 retry with Retry-After (capped 5s, max 3 retries, ±20% jitter),
 * and returns {ok, status, data, error} — never throws across the module
 * boundary.
 */

const DEFAULT_BASE = "https://api.openphone.com/v1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildQuery(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) qs.append(key, String(item));
    } else {
      qs.append(key, String(value));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.baseUrl="https://api.openphone.com/v1"]
 * @param {string} [opts.userAgent="backtalk/0.1"]
 * @param {number} [opts.timeoutMs=15000]
 * @param {number} [opts.maxRetries=3] 429 retries.
 * @param {Function} [opts.fetchImpl] Injectable fetch for tests.
 */
export function createQuoClient({
  apiKey,
  baseUrl = DEFAULT_BASE,
  userAgent = "backtalk/0.1",
  timeoutMs = 15000,
  maxRetries = 3,
  fetchImpl,
} = {}) {
  async function request(method, path, { query, body } = {}) {
    const f = fetchImpl ?? globalThis.fetch;
    const url = `${String(baseUrl).replace(/\/+$/, "")}${path}${buildQuery(query)}`;
    const headers = {
      authorization: apiKey ?? "", // raw key — no Bearer prefix
      "user-agent": userAgent,
      accept: "application/json",
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        return { ok: false, status: 0, data: null, error: String((err && err.message) || err) };
      }

      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        let delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 1000;
        delay = Math.round(delay * (0.8 + Math.random() * 0.4)); // ±20% jitter
        attempt += 1;
        await sleep(delay);
        continue;
      }

      let text = "";
      try {
        text = await res.text();
      } catch {
        // tolerate unreadable bodies
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // tolerate non-JSON error bodies
      }
      if (res.ok) return { ok: true, status: res.status, data, error: null };

      const message =
        data?.message ??
        data?.error?.message ??
        data?.errors?.[0]?.message ??
        (text ? text.slice(0, 300) : `HTTP ${res.status}`);
      return {
        ok: false,
        status: res.status,
        data,
        error: typeof message === "string" ? message : JSON.stringify(message),
      };
    }
  }

  return {
    /** 404 is "no transcript for this call" — normal, not an error. */
    getTranscript: (callId) => request("GET", `/call-transcripts/${encodeURIComponent(callId)}`),

    /** Authoritative from/to/direction/duration when the webhook is ambiguous. */
    getCall: (callId) => request("GET", `/calls/${encodeURIComponent(callId)}`),

    listTasks: ({ maxResults = 100, pageToken } = {}) =>
      request("GET", "/tasks", { query: { maxResults, ...(pageToken ? { pageToken } : {}) } }),

    /**
     * POST /v1/tasks. Payload must carry EXACTLY ONE linkage field
     * (activityId | conversationId | phoneNumberId) — the caller builds it
     * from the verified webhook payload only.
     */
    createTask: (payload) => request("POST", "/tasks", { body: payload }),

    /**
     * Phone-based conversation lookup — the documented fallback linkage.
     * GET /v1/conversations?phoneNumbers[]=<E.164> → first conversation id.
     */
    async resolveConversationId(e164) {
      const r = await request("GET", "/conversations", { query: { "phoneNumbers[]": e164 } });
      if (!r.ok) return { ok: false, status: r.status, conversationId: null, error: r.error };
      const id = r.data?.data?.[0]?.id ?? null;
      return { ok: true, status: r.status, conversationId: id, error: null };
    },
  };
}
