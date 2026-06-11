# Architecture

BackTalk is a deliberately small machine: one HTTP server, four stages, no database, no queue, no framework. This document explains the pipeline, the event model, the idempotency design, and the reasoning behind the parts that look opinionated.

## Design goals

1. **Stateless pass-through.** A transcript flows through memory and is gone. The only durable state, and only if you opt in, is a set of processed call ids.
2. **Fail closed on security, fail soft on operations.** A bad signature is a hard 401. A flaky LLM or a surprising Quo response degrades to logging the intended work, never to dropping it silently or doing something unverified.
3. **Zero dependencies.** Everything is Node >= 20 built-ins. Nothing to audit but this repo; nothing to update but this repo.
4. **The LLM is a narrow, untrusted subcontractor.** It reads text and proposes JSON. Deterministic code decides what, if anything, happens.

## The four stages

```
  Quo workspace                         your infrastructure
 ───────────────                ───────────────────────────────────
                                 BackTalk (server.js)

  call ends
     │
  transcript ready
     │
     │  POST /webhook
     │  call.transcript.completed
     ▼
  ┌──────────────────────┐
  │ 1 RECEIVE + VERIFY   │  raw body read first → HMAC verify
  │   lib/verify.js      │  (both schemes, skew window, fail closed)
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐
  │ 2 TRANSCRIPT ACQUIRE │  dialogue is inline in the event payload
  │   server.js          │  guards: status, duration, empty, duplicate
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐      POST {LLM_BASE_URL}/chat/completions
  │ 3 LLM EXTRACTION     │ ───► or api.anthropic.com/v1/messages
  │   lib/extract.js     │ ◄─── JSON: call_summary + commitments[]
  │   lib/llm.js         │
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐
  │ 4 VALIDATE + CREATE  │  deterministic validation + scrub, then
  │   lib/extract.js     │ ───► POST api.openphone.com/v1/tasks
  │   lib/quo.js         │      (one per surviving commitment —
  └──────────────────────┘       the pipeline's only write)
```

## Dual-event model

Quo emits two relevant webhook events, and they are not interchangeable:

| Event | Carries | Use |
|---|---|---|
| `call.transcript.completed` | The **full dialogue array inline** (`callId`, `status`, `duration`, `dialogue[]`) | **Preferred.** The happy path needs zero read calls to the Quo API. |
| `call.completed` | Call metadata only (from/to/direction/duration) — no transcript | Fallback trigger only, behind `FALLBACK_POLL=1`. |

**Webhook-first is the design.** Subscribe to `call.transcript.completed` and the provider tells you exactly when there is something to do, with everything needed to do it.

**The fallback poll** exists for accounts that can only subscribe to `call.completed`. With `FALLBACK_POLL=1`, the server acks the event immediately, marks the call id `pending`, then polls `GET /v1/call-transcripts/{callId}` in-process on a bounded backoff schedule: 30s, 60s, 120s, 240s, 480s (5 attempts, ~15.5 minutes total). A completed transcript enters the pipeline at stage 2; a 404 or `in-progress` keeps polling; an exhausted budget or a `failed`/`absent` status marks the call `skipped:no_transcript`. A 404 from the transcript endpoint is *normal* (not every call produces a transcript) and is never treated as an error.

## Webhook handling details

- **Raw body first.** The body is read as text before any JSON parsing, because signature verification operates on exact bytes (beta scheme) or a canonical re-serialization (current scheme). Parse-then-verify orderings are a classic source of bypasses.
- **Two signing schemes, auto-detected** by header presence; multi-secret support so each registered webhook keeps its own secret. Details and properties (timing-safe, fail-closed) are in [SECURITY.md](../SECURITY.md).
- **Tolerant payload shapes.** The event object may sit at `body.data.object`, `body.data`, or the body root; the event type at `body.type` or `body.event`. Providers move envelopes around more often than they document.
- **Ack philosophy.** Every *benign* skip returns HTTP 200 with `{"ok":true,"skipped":"<reason>"}` — too short, empty transcript, duplicate, no transcript, no surviving commitments. A 200 tells the provider to stop redelivering something that will never produce work. Only *transient* faults (LLM 5xx after retries, Quo 5xx on task creation) return 500, because there redelivery actually helps — and the idempotency lifecycle makes the retry safe.
- **Guards run before any LLM spend.** Duration below `MIN_CALL_SECONDS` (voicemail, misdials) and empty flattened transcripts are filtered before a single token is paid for.

## Idempotency design

Webhook providers redeliver; networks duplicate; operators replay. Three layers keep one call from becoming two sets of tasks:

1. **Call-id claim (primary).** Before processing, the call id is claimed in an in-memory LRU map (capacity `IDEMPOTENCY_MAX`, default 5000) with a status lifecycle:

   ```
   (absent) ──claim──► processing ──► done | skipped     (terminal)
                            │
                            └──────► failed  ──re-claim──► processing
   ```

   A delivery for an id in `processing`, `done`, or `skipped` gets `200 {"duplicate":true}`. Only `failed` may be re-claimed — that is exactly the case where provider redelivery is wanted.

2. **Optional file store.** `IDEMPOTENCY_FILE` persists the set across restarts as `{callId, status, ts}` entries — no transcript text, no PII. Writes are atomic (write temp file, then rename), so a crash mid-write can't corrupt the store.

3. **Effect-level marker (survives store loss).** Every task description ends with `Source: backtalk ref:<callId>/<n>`. Before creating tasks, the server lists existing tasks and skips any commitment whose marker already appears. This is best-effort (first page, workspace-wide) — it is the safety net under the claim, not a replacement for it.

## Transcript processing

- **Speaker labeling is structural, never textual.** A dialogue turn with a `userId` is an internal workspace speaker → `AGENT:`; a turn with only an external E.164 identifier → `CALLER:`. `OWNED_NUMBERS` exists for forwarded-line edge cases where a staff line appears as an external number. Names spoken *in* the transcript are never used for identity — that text is attacker-controllable.
- **Sanitization at flatten time.** Empty turns are dropped; control and zero-width characters are stripped (they are a known smuggling channel for hiding instructions from human review).
- **The 60/40 cap.** Transcripts above `MAX_TRANSCRIPT_CHARS` are trimmed to the first 60% and last 40% of the budget with a `[... middle trimmed ...]` marker. The opening of a call carries the context (who, why); commitments cluster at the close ("so I'll send that over, and you'll..."). The middle is the cheapest part to lose. The trim affects model input only — the full transcript is never stored anywhere regardless.

## LLM stage

`lib/llm.js` exposes one entrypoint, `chatJson({system, user})`, over two adapters:

- **openai** — any OpenAI-compatible chat-completions endpoint (OpenRouter, OpenAI, Groq, Ollama, LM Studio) selected by `LLM_BASE_URL`. Requests ask for `response_format: {type:"json_object"}`; endpoints that reject that parameter (some local builds) get one retry without it, because the validation layer tolerates prose-wrapped JSON anyway.
- **anthropic** — the native Messages API at a fixed base URL.

Operating posture: temperature 0.2, bounded output tokens, 60s timeout. If the primary model returns empty or invalid JSON, the call is retried once with `LLM_FALLBACK_MODEL` *if configured* — a model name can come only from `.env`, never from input. Still invalid → the delivery fails as transient (500), the call id is marked `failed`, and provider redelivery gets another chance.

## The validation layer (stage 4, first half)

Everything the model returns passes through `parseAndValidate` — deterministic code with no model in the loop. In order: tolerant JSON extraction; shape and type coercion; enum whitelists (`who`, `confidence`); the who/confidence filters (`INCLUDE_CALLER_COMMITMENTS`, `MIN_CONFIDENCE`); the **groundedness check** (each `verbatim_quote` must literally appear in the normalized transcript — this single check kills both hallucinated promises and injection-fabricated tasks); the due-date sanity window (call date → +365 days, out-of-window dates are nulled, not fatal); the caps (8 tasks hard ceiling, 80-char titles, 200-char details); the exfil scrub (URLs, emails, phone shapes → `[removed]`); and a sentence-level injection lint. Every drop is recorded with a reason.

The full security rationale lives in [SECURITY.md](../SECURITY.md). The architectural point: **stage 3 proposes, stage 4 disposes.**

## Task creation (stage 4, second half)

Each surviving commitment becomes one `POST /v1/tasks`:

```json
{
  "title":       "Send the updated fee schedule",
  "description": "Email Casey Caller the updated fee schedule.\nQuote: \"I'll email you the updated fee schedule tomorrow morning\"\nSpoken due: tomorrow morning\nSource: backtalk ref:ACfictional0000000001/1",
  "activityId":  "ACfictional0000000001",
  "dueDate":     "2026-06-12T09:00:00-04:00"
}
```

- **Exactly one linkage field.** The Tasks API accepts `phoneNumberId`, `conversationId`, or `activityId` — sending two is a 400. The primary linkage is `activityId`: the call id arrives in the verified webhook payload, costs zero lookups, and pins the task to the exact call.
- **Fallback chain.** If a `POST` rejects the linkage field, the server retries once with a `conversationId` resolved via `GET /v1/conversations?phoneNumbers[]=<caller E.164>`. If that also fails — or on any persistent 4xx — it **degrades to log-only for that delivery**: the full intended payload is logged at warn level with `FALLBACK:LOG_ONLY`, counts report `created:0, logged:N`, and the response is still 200. The data is captured and the operator is told; nothing is silently lost and nothing unverified is forced through.
- **`DRY_RUN=1`** forces log-only mode globally — the development default against any real account.
- **Unset fields are omitted**, not sent as null (`dueDate`, `assignedTo`).
- **Rate limits:** 429s honor `Retry-After` (capped at 5s), max 3 retries with ±20% jitter, applied to all Quo calls. Other 4xx are terminal for that request — retrying a deterministic rejection is noise.
- **API hygiene** (`lib/quo.js`): every request carries a real `User-Agent` (Cloudflare rejects default library agents), a 15s `AbortSignal.timeout`, and the provider's auth quirk — the raw API key in `Authorization`, no `Bearer ` prefix. The module returns `{ok, status, data, error}` and never throws across its boundary.

## Serverless caveats

The webhook-first path is *nearly* serverless-friendly, with honest limits:

- **In-process timers don't survive serverless.** `FALLBACK_POLL` schedules in-memory timers minutes into the future; a platform that freezes or kills the instance after responding will drop them. The fallback poll requires a long-running host. (The preferred `call.transcript.completed` path needs no timers at all.)
- **In-memory idempotency resets on cold start**, and `IDEMPOTENCY_FILE` assumes a persistent writable disk. On ephemeral platforms you lose the claim layer across restarts — the effect-level `ref:` marker check still prevents duplicate tasks, at the cost of one extra GET per delivery.
- A small always-on container (the provided `Dockerfile` is ~the Node base image plus this repo) sidesteps all of this and is the recommended deployment.

## Why zero dependencies

The tool handles webhook secrets, an API key to a live phone system, and the spoken words of real customers. Every package added to that mix is supply-chain surface someone else controls. Node >= 20 ships everything this problem actually needs — `node:http`, `node:crypto`, `fetch`, `AbortSignal.timeout`, `node:test` — so the entire auditable surface is this repository.
