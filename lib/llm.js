/**
 * lib/llm.js — provider adapters with one entrypoint: chatJson().
 *
 * Providers:
 *   "openai"    — any OpenAI-compatible /chat/completions endpoint
 *                 (OpenRouter, OpenAI, Groq, Ollama, LM Studio) via base URL.
 *   "anthropic" — native Messages API (fixed https://api.anthropic.com).
 *
 * The model name always comes from configuration — never from input.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

async function postJson(url, headers, body, timeoutMs, fetchImpl) {
  const f = fetchImpl ?? globalThis.fetch;
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawText = await res.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      // tolerate non-JSON error bodies
    }
    return { status: res.status, ok: res.ok, data, rawText };
  } catch (err) {
    return { status: 0, ok: false, data: null, rawText: "", error: String((err && err.message) || err) };
  }
}

function errorFrom(r) {
  return (
    r.error ??
    r.data?.error?.message ??
    (r.rawText ? r.rawText.slice(0, 200) : `HTTP ${r.status}`)
  );
}

/**
 * One chat call expected to return a JSON object as text.
 *
 * @param {object} opts
 * @param {"openai"|"anthropic"} [opts.provider="openai"]
 * @param {string} [opts.baseUrl="https://openrouter.ai/api/v1"] openai provider only.
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {number} [opts.timeoutMs=60000]
 * @param {Function} [opts.fetchImpl] Injectable fetch for tests.
 * @returns {Promise<{ok: boolean, text: string, model: string|null, status?: number, error?: string}>}
 */
export async function chatJson({
  provider = "openai",
  baseUrl = "https://openrouter.ai/api/v1",
  apiKey,
  model,
  system,
  user,
  timeoutMs = 60000,
  fetchImpl,
} = {}) {
  if (!model) return { ok: false, text: "", model: null, error: "model is required" };

  if (provider === "anthropic") {
    const r = await postJson(
      ANTHROPIC_URL,
      { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
      {
        model,
        system,
        messages: [{ role: "user", content: user }],
        temperature: 0.2,
        max_tokens: 2000,
      },
      timeoutMs,
      fetchImpl,
    );
    if (!r.ok) return { ok: false, text: "", model, status: r.status, error: errorFrom(r) };
    const text = typeof r.data?.content?.[0]?.text === "string" ? r.data.content[0].text : "";
    if (!text) return { ok: false, text: "", model, status: r.status, error: "empty completion" };
    return { ok: true, text, model, status: r.status };
  }

  if (provider !== "openai") {
    return { ok: false, text: "", model, error: `unknown LLM_PROVIDER: ${provider}` };
  }

  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const headers = { authorization: `Bearer ${apiKey ?? ""}` };
  const baseBody = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: 2000,
  };

  let r = await postJson(url, headers, { ...baseBody, response_format: { type: "json_object" } }, timeoutMs, fetchImpl);
  if (r.status === 400) {
    // Some OpenAI-compatible servers (older Ollama / LM Studio builds) reject
    // response_format. Retry once without it — Layer-2 parsing tolerates
    // prose-wrapped JSON.
    r = await postJson(url, headers, baseBody, timeoutMs, fetchImpl);
  }
  if (!r.ok) return { ok: false, text: "", model, status: r.status, error: errorFrom(r) };

  let content = r.data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  const text = typeof content === "string" ? content : "";
  if (!text) return { ok: false, text: "", model, status: r.status, error: "empty completion" };
  return { ok: true, text, model, status: r.status };
}
