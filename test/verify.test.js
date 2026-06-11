import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { verifyWebhook } from "../lib/verify.js";

const NOW_MS = Date.UTC(2026, 5, 11, 14, 0, 0); // fixed clock for determinism
const BODY = JSON.stringify({
  id: "EVfictional000000000001",
  type: "call.transcript.completed",
  data: { object: { callId: "ACfictional0000000001", status: "completed" } },
});

const SECRET_A = randomBytes(32).toString("base64");
const SECRET_B = `whsec_${randomBytes(32).toString("base64")}`;

function signSchemeA(rawBody, tsMs, secretB64) {
  const canonical = JSON.stringify(JSON.parse(rawBody));
  const key = Buffer.from(secretB64, "base64");
  return createHmac("sha256", key).update(`${tsMs}.${canonical}`).digest("base64");
}

function headersSchemeA(rawBody, tsMs, secretB64) {
  return { "openphone-signature": `hmac;1;${tsMs};${signSchemeA(rawBody, tsMs, secretB64)}` };
}

function signSchemeB(rawBody, id, tsSeconds, whsecSecret) {
  const key = Buffer.from(whsecSecret.slice(6), "base64");
  return createHmac("sha256", key).update(`${id}.${tsSeconds}.${rawBody}`).digest("base64");
}

function headersSchemeB(rawBody, id, tsSeconds, whsecSecret) {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(tsSeconds),
    "webhook-signature": `v1,${signSchemeB(rawBody, id, tsSeconds, whsecSecret)}`,
  };
}

// ----------------------------------------------------------- Scheme A

test("scheme A: valid signature accepted", () => {
  const r = verifyWebhook(BODY, headersSchemeA(BODY, NOW_MS, SECRET_A), SECRET_A, { nowMs: NOW_MS });
  assert.equal(r.ok, true);
  assert.equal(r.scheme, "openphone");
});

test("scheme A: whitespace-variant body still verifies (canonical re-serialization)", () => {
  const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
  const headers = headersSchemeA(BODY, NOW_MS, SECRET_A); // signed over the minified form
  const r = verifyWebhook(pretty, headers, SECRET_A, { nowMs: NOW_MS });
  assert.equal(r.ok, true);
});

test("scheme A: tampered body rejected", () => {
  const headers = headersSchemeA(BODY, NOW_MS, SECRET_A);
  const tampered = BODY.replace("completed", "comprised");
  const r = verifyWebhook(tampered, headers, SECRET_A, { nowMs: NOW_MS });
  assert.equal(r.ok, false);
});

test("scheme A: timestamp outside skew window rejected (both directions)", () => {
  for (const offset of [301000, -301000]) {
    const ts = NOW_MS - offset;
    const r = verifyWebhook(BODY, headersSchemeA(BODY, ts, SECRET_A), SECRET_A, {
      nowMs: NOW_MS,
      skewSeconds: 300,
    });
    assert.equal(r.ok, false, `offset ${offset} should be rejected`);
    assert.match(r.reason, /skew/);
  }
  // just inside the window is fine
  const ok = verifyWebhook(BODY, headersSchemeA(BODY, NOW_MS - 299000, SECRET_A), SECRET_A, {
    nowMs: NOW_MS,
    skewSeconds: 300,
  });
  assert.equal(ok.ok, true);
});

test("scheme A: second of two configured secrets verifies (multi-webhook support)", () => {
  const otherSecret = randomBytes(32).toString("base64");
  const headers = headersSchemeA(BODY, NOW_MS, SECRET_A);
  const asString = verifyWebhook(BODY, headers, `${otherSecret},${SECRET_A}`, { nowMs: NOW_MS });
  assert.equal(asString.ok, true);
  const asArray = verifyWebhook(BODY, headers, [otherSecret, SECRET_A], { nowMs: NOW_MS });
  assert.equal(asArray.ok, true);
});

test("scheme A: malformed headers rejected", () => {
  const cases = [
    `hmac;1;${NOW_MS}`, // 3 parts
    `rsa;1;${NOW_MS};AAAA`, // wrong scheme
    `hmac;2;${NOW_MS};AAAA`, // wrong version
    `hmac;1;not-a-number;AAAA`, // bad timestamp
  ];
  for (const header of cases) {
    const r = verifyWebhook(BODY, { "openphone-signature": header }, SECRET_A, { nowMs: NOW_MS });
    assert.equal(r.ok, false, `header "${header}" should be rejected`);
  }
});

test("scheme A: signature length mismatch fails without throwing (timing-safe)", () => {
  const headers = { "openphone-signature": `hmac;1;${NOW_MS};AAAA` };
  let r;
  assert.doesNotThrow(() => {
    r = verifyWebhook(BODY, headers, SECRET_A, { nowMs: NOW_MS });
  });
  assert.equal(r.ok, false);
});

test("scheme A: non-base64 secret fails closed without throwing", () => {
  const headers = headersSchemeA(BODY, NOW_MS, SECRET_A);
  let r;
  assert.doesNotThrow(() => {
    r = verifyWebhook(BODY, headers, "!!!not base64 at all!!!", { nowMs: NOW_MS });
  });
  assert.equal(r.ok, false);
});

test("scheme A: non-JSON body fails closed", () => {
  const r = verifyWebhook("not json", { "openphone-signature": `hmac;1;${NOW_MS};AAAA` }, SECRET_A, {
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
});

// ----------------------------------------------------------- Scheme B

const MSG_ID = "msgfictional0001";
const NOW_S = Math.floor(NOW_MS / 1000);

test("scheme B: valid whsec_ signature accepted", () => {
  const r = verifyWebhook(BODY, headersSchemeB(BODY, MSG_ID, NOW_S, SECRET_B), SECRET_B, { nowMs: NOW_MS });
  assert.equal(r.ok, true);
  assert.equal(r.scheme, "svix");
});

test("scheme B: accepts Buffer raw body (exact bytes, no re-serialization)", () => {
  const buf = Buffer.from(BODY, "utf8");
  const r = verifyWebhook(buf, headersSchemeB(BODY, MSG_ID, NOW_S, SECRET_B), SECRET_B, { nowMs: NOW_MS });
  assert.equal(r.ok, true);
});

test("scheme B: tampered body rejected", () => {
  const headers = headersSchemeB(BODY, MSG_ID, NOW_S, SECRET_B);
  const r = verifyWebhook(BODY.replace("completed", "comprised"), headers, SECRET_B, { nowMs: NOW_MS });
  assert.equal(r.ok, false);
});

test("scheme B: timestamp outside skew window rejected", () => {
  const r = verifyWebhook(BODY, headersSchemeB(BODY, MSG_ID, NOW_S - 301, SECRET_B), SECRET_B, {
    nowMs: NOW_MS,
    skewSeconds: 300,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /skew/);
});

test("scheme B: matches any entry in a space-separated signature list", () => {
  const good = signSchemeB(BODY, MSG_ID, NOW_S, SECRET_B);
  const headers = {
    "webhook-id": MSG_ID,
    "webhook-timestamp": String(NOW_S),
    "webhook-signature": `v1,AAAAAAAA v1,${good}`,
  };
  const r = verifyWebhook(BODY, headers, SECRET_B, { nowMs: NOW_MS });
  assert.equal(r.ok, true);
});

// ----------------------------------------------------------- secret routing + misc

test("whsec_ secrets are only used for scheme B and vice versa", () => {
  const both = [SECRET_A, SECRET_B];
  const a = verifyWebhook(BODY, headersSchemeA(BODY, NOW_MS, SECRET_A), both, { nowMs: NOW_MS });
  assert.equal(a.ok, true, "scheme A verifies with the base64 secret even when a whsec_ secret is configured");
  const b = verifyWebhook(BODY, headersSchemeB(BODY, MSG_ID, NOW_S, SECRET_B), both, { nowMs: NOW_MS });
  assert.equal(b.ok, true, "scheme B verifies with the whsec_ secret even when a base64 secret is configured");
  // scheme A signed with the whsec_ secret's bytes must NOT verify via scheme A path
  const wrong = verifyWebhook(BODY, headersSchemeA(BODY, NOW_MS, SECRET_B.slice(6)), [SECRET_B], { nowMs: NOW_MS });
  assert.equal(wrong.ok, false);
});

test("no signature headers → rejected with explicit reason", () => {
  const r = verifyWebhook(BODY, { "content-type": "application/json" }, SECRET_A, { nowMs: NOW_MS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no signature header");
});

test("no secrets configured → rejected", () => {
  const r = verifyWebhook(BODY, headersSchemeA(BODY, NOW_MS, SECRET_A), "", { nowMs: NOW_MS });
  assert.equal(r.ok, false);
});
