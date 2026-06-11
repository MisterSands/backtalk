/**
 * lib/verify.js — pure webhook signature verification.
 *
 * Two schemes, auto-detected by header presence:
 *
 *   Scheme A ("openphone"): single `openphone-signature` header of the form
 *     `hmac;1;<unix-ms-timestamp>;<base64 signature>`. The provider signs the
 *     whitespace-stripped (minified) JSON body, so we verify against the
 *     canonical re-serialization of the raw body, not the raw bytes.
 *
 *   Scheme B ("svix"): `webhook-id` + `webhook-timestamp` (unix SECONDS) +
 *     `webhook-signature` (space-separated `v1,<base64>` entries) headers,
 *     used with `whsec_`-prefixed secrets. Signed data is the EXACT raw body
 *     bytes — no re-serialization.
 *
 * No env reads, no I/O. Fail closed on every parse/decode error.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Timing-safe string comparison; length mismatch fails without throwing. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function lowercaseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function normalizeSecrets(secrets) {
  const list = Array.isArray(secrets) ? secrets : String(secrets ?? "").split(",");
  return list.map((s) => String(s).trim()).filter(Boolean);
}

function bodyText(rawBody) {
  return typeof rawBody === "string" ? rawBody : Buffer.from(rawBody ?? "").toString("utf8");
}

function bodyBuffer(rawBody) {
  return typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody ?? "");
}

function fail(scheme, reason) {
  return { ok: false, scheme, reason };
}

function verifySchemeA(rawBody, header, secrets, skewSeconds, nowMs) {
  const parts = String(header).split(";");
  if (parts.length !== 4) return fail("openphone", "malformed header (expected 4 parts)");
  const [scheme, version, timestamp, signature] = parts;
  if (scheme !== "hmac") return fail("openphone", "unsupported scheme");
  if (version !== "1") return fail("openphone", "unsupported version");

  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs)) return fail("openphone", "bad timestamp");
  if (Math.abs(nowMs - tsMs) > skewSeconds * 1000) {
    return fail("openphone", "timestamp outside skew window");
  }

  let canonical;
  try {
    canonical = JSON.stringify(JSON.parse(bodyText(rawBody)));
  } catch {
    return fail("openphone", "body is not valid JSON");
  }
  const signedData = `${timestamp}.${canonical}`;

  for (const secret of secrets) {
    if (secret.startsWith("whsec_")) continue; // scheme-B secret; not valid here
    try {
      const key = Buffer.from(secret, "base64");
      if (key.length === 0) continue;
      const digest = createHmac("sha256", key).update(signedData).digest("base64");
      if (safeEqual(digest, signature)) return { ok: true, scheme: "openphone", reason: null };
    } catch {
      // fail closed for this secret, keep trying the rest
    }
  }
  return fail("openphone", "signature mismatch");
}

function verifySchemeB(rawBody, headers, secrets, skewSeconds, nowMs) {
  const webhookId = headers["webhook-id"];
  const webhookTimestamp = headers["webhook-timestamp"];
  const signatureHeader = headers["webhook-signature"];

  const tsSeconds = Number(webhookTimestamp);
  if (!Number.isFinite(tsSeconds)) return fail("svix", "bad timestamp");
  if (Math.abs(nowMs / 1000 - tsSeconds) > skewSeconds) {
    return fail("svix", "timestamp outside skew window");
  }

  // Exact raw body bytes — no re-serialization.
  const signedData = Buffer.concat([
    Buffer.from(`${webhookId}.${webhookTimestamp}.`, "utf8"),
    bodyBuffer(rawBody),
  ]);

  const candidates = String(signatureHeader)
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const comma = entry.indexOf(",");
      if (comma <= 0) return null;
      return entry.slice(0, comma) === "v1" ? entry.slice(comma + 1) : null;
    })
    .filter(Boolean);
  if (candidates.length === 0) return fail("svix", "no v1 signature entries");

  for (const secret of secrets) {
    if (!secret.startsWith("whsec_")) continue; // scheme-A secret; not valid here
    try {
      const key = Buffer.from(secret.slice(6), "base64");
      if (key.length === 0) continue;
      const expected = createHmac("sha256", key).update(signedData).digest("base64");
      for (const candidate of candidates) {
        if (safeEqual(expected, candidate)) return { ok: true, scheme: "svix", reason: null };
      }
    } catch {
      // fail closed for this secret, keep trying the rest
    }
  }
  return fail("svix", "signature mismatch");
}

/**
 * Verify a webhook delivery.
 *
 * @param {string|Buffer} rawBody   Exact request body as received.
 * @param {object} headers          Request headers (any casing).
 * @param {string|string[]} secrets Comma-separated string or array. Entries are
 *                                  either base64 keys (Scheme A) or `whsec_...`
 *                                  values (Scheme B). Any one match accepts.
 * @param {object} [opts]
 * @param {number} [opts.skewSeconds=300] Replay window.
 * @param {number} [opts.nowMs=Date.now()] Injectable clock for tests.
 * @returns {{ok: boolean, scheme: string|null, reason: string|null}}
 */
export function verifyWebhook(rawBody, headers, secrets, { skewSeconds = 300, nowMs = Date.now() } = {}) {
  const h = lowercaseHeaders(headers);
  const secretList = normalizeSecrets(secrets);
  if (secretList.length === 0) return fail(null, "no secrets configured");

  if (h["openphone-signature"]) {
    return verifySchemeA(rawBody, h["openphone-signature"], secretList, skewSeconds, nowMs);
  }
  if (h["webhook-id"] && h["webhook-timestamp"] && h["webhook-signature"]) {
    return verifySchemeB(rawBody, h, secretList, skewSeconds, nowMs);
  }
  return fail(null, "no signature header");
}
