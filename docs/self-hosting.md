# Self-hosting BackTalk

Run the full Node reference server on your own infrastructure. You get the complete deterministic validation layer and keep the entire pipeline on hardware you control. (No-coders don't need any of this — use Make, Zapier, or n8n from the [README](../README.md).)

Every setting below is also available as a field inside your Zap or Make scenario — no-coders set values in those fields, not in a `.env` file.

## How it works

Four stages, nothing else. Stateless pass-through: no transcript persisted, no PII stored.

```
              Quo (formerly OpenPhone)
                        |
                        |  webhook: call.transcript.completed
                        |  (payload carries the full dialogue — no polling)
                        v
        +-----------------------------------------+
        |                BackTalk                 |
        |                                         |
        |  1  receive + verify                    |
        |     HMAC signature, replay window,      |
        |     fail closed                         |
        |                  |                      |
        |  2  transcript acquire                  |
        |     inline from the webhook payload;    |
        |     guards: min duration, idempotency   |
        |                  |                      |
        |  3  AI promise extraction               |
        |     the endpoint YOU configure          |
        |     (OpenRouter / OpenAI / Anthropic /  |
        |      Groq / Ollama / LM Studio)         |
        |                  |                      |
        |  4  validate + create tasks             |
        |     deterministic checks, exfil scrub,  |
        |     then POST /v1/tasks (only write)    |
        +-----------------------------------------+
                        |
                        v
          Native Quo Task, linked to the call
          title · quote · spoken due date
```

The design is webhook-first: subscribe to `call.transcript.completed` and the event payload already contains the whole dialogue array, so the happy path makes **zero** read calls to the Quo API. (An optional `FALLBACK_POLL` mode exists for accounts that can only subscribe to `call.completed` — see [architecture.md](architecture.md).)

## Path 1 — Node (recommended: full validation layer)

Requires Node >= 20. There is nothing to install — zero dependencies.

```bash
git clone https://github.com/MisterSands/backtalk.git
cd backtalk
cp .env.example .env     # fill in QUO_API_KEY, QUO_WEBHOOK_SECRET, LLM_API_KEY, LLM_MODEL
node server.js           # listens on :8787
```

**Test locally first** — no Quo account, no signature, no writes — you only need your LLM key (or a local Ollama):

```bash
ALLOW_UNSIGNED=1 DRY_RUN=1 node server.js
# Windows PowerShell: $env:ALLOW_UNSIGNED='1'; $env:DRY_RUN='1'; node server.js
# in another terminal:
curl -X POST localhost:8787/webhook \
  -H "content-type: application/json" \
  -d @fixtures/sample-webhook.json
```

You'll see the exact task payloads it *would* create, logged with a `[DRY_RUN]` prefix.

Then go live:

1. Expose the server over HTTPS (any tunnel or host works).
2. In the Quo dashboard, create a webhook pointing at `https://<your-host>/webhook`, subscribed to **`call.transcript.completed`** only.
3. Paste the signing key Quo shows you into `QUO_WEBHOOK_SECRET`, unset `ALLOW_UNSIGNED` and `DRY_RUN`, restart.

## Path 2 — Docker

```bash
docker build -t backtalk .
docker run --env-file .env -p 8787:8787 backtalk
```

Same env contract, same `/webhook` endpoint. `GET /healthz` is your liveness probe.

## Path 3 — Deploy to Render (browser-only, no terminal)

The repo ships a [`render.yaml`](../render.yaml) blueprint, so you can stand the whole thing up from a browser:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/MisterSands/backtalk)

1. **Click the button** (free Render account works). Render reads `render.yaml` and prompts you for the four required values: `QUO_API_KEY`, `QUO_WEBHOOK_SECRET`, `LLM_API_KEY`, `LLM_MODEL`.
   - Don't have the webhook secret yet? Enter a placeholder for `QUO_WEBHOOK_SECRET` — you'll get the real one in step 3.
2. **Deploy.** When it's live, copy your service URL: `https://<your-app>.onrender.com`.
3. **In the Quo dashboard** → webhooks → create a webhook pointing at `https://<your-app>.onrender.com/webhook`, subscribed to **`call.transcript.completed`** only. Quo shows you the signing key — copy it.
4. **Back in Render** → your service → Environment → set `QUO_WEBHOOK_SECRET` to that signing key. The service restarts automatically.
5. **Verify:** open `https://<your-app>.onrender.com/healthz` — you should see `{"ok":true}`. Make a test call; when the transcript completes, a task appears on the call's contact.

Caveats for the free tier: the instance spins down when idle, so the first webhook after a quiet period waits out a cold start (Quo retries deliveries, so nothing is lost — it's just slower). The in-memory dedupe also resets on every spin-down; the `ref:` marker check still prevents duplicate tasks.

## Other hosts

Any long-running Node 20+ host works. Two well-documented options:

- Render web services: <https://render.com/docs/web-services>
- Railway: <https://docs.railway.com/guides/express>

(Plain docs links — no tracking, no referrals.) Serverless platforms work for the webhook-first path with caveats (in-memory dedupe resets on cold start; `FALLBACK_POLL` and `IDEMPOTENCY_FILE` need a persistent process) — see [architecture.md](architecture.md).

## Configuration

Everything is configured via `.env` (see [`.env.example`](../.env.example) for the commented version). No-coders set these same values as fields inside their Zap or Make scenario instead.

| Var | Required | Default | Meaning |
|---|---|---|---|
| `QUO_API_KEY` | yes | — | Quo API key. Sent raw (no Bearer prefix). |
| `QUO_WEBHOOK_SECRET` | yes* | — | Webhook signing secret(s), comma-separated to support one secret per registered webhook. Each entry is either a base64 `key` from webhook creation (current scheme) or a `whsec_...` value (beta scheme). *Optional only when `ALLOW_UNSIGNED=1`. |
| `LLM_PROVIDER` | no | `openai` | `openai` (OpenAI-compatible: OpenRouter, OpenAI, Groq, Ollama, LM Studio) or `anthropic` (native Messages API). |
| `LLM_BASE_URL` | no | `https://openrouter.ai/api/v1` | Base URL for the openai provider. Ollama example: `http://localhost:11434/v1`. Ignored by `anthropic`. |
| `LLM_API_KEY` | yes | — | Key for the chosen provider (any non-empty string for Ollama/LM Studio). |
| `LLM_MODEL` | yes | — | Model id, e.g. `anthropic/claude-haiku-4.5` (OpenRouter id). Any chat model that can follow a JSON schema works — check your provider's model list. |
| `LLM_FALLBACK_MODEL` | no | unset | Retried once if the primary returns empty/invalid JSON. Never taken from input. |
| `INCLUDE_CALLER_COMMITMENTS` | no | `0` | `1` → also file the caller's commitments (who=caller). |
| `MIN_CALL_SECONDS` | no | `30` | Calls shorter than this are skipped (voicemail/misdial guard) before any LLM spend. |
| `MAX_TASKS_PER_CALL` | no | `8` | Post-validation cap. Hard ceiling 8 — env may lower it, never raise it. |
| `MAX_TRANSCRIPT_CHARS` | no | `24000` | Head 60% + tail 40% cap with `[... middle trimmed ...]` marker (trim is model-input only; the full transcript is never stored). |
| `MIN_CONFIDENCE` | no | `medium` | Threshold for extracted commitments (`low`\|`medium`\|`high`). |
| `LOW_CONFIDENCE_MODE` | no | `drop` | What happens below the threshold: `drop` (discard) or `review` (file with a `[Review]` title prefix so a human triages). |
| `ASSIGN_MODE` | no | `default` | `default` = `QUO_DEFAULT_ASSIGNEE` / per-line assignee; `call-user` = assign to the rep who was on the call (structural `userId` from `GET /calls`); `none` = unassigned. |
| `LINE_CONFIG` | no | unset | JSON object of per-line profiles keyed by E.164 or `PN...` id: `skip`, `minConfidence`, `assignee`, `includeCallerCommitments`, `maxTasksPerCall`. |
| `OWNED_NUMBERS` | no | unset | Fallback speaker map: `+15555550100=Alex Agent,+15555550101=Bailey Agent`. Matching identifiers are forced to AGENT. |
| `QUO_DEFAULT_ASSIGNEE` | no | unset | User id applied as `assignedTo` on every created task. |
| `TIMEZONE` | no | `UTC` | IANA tz passed into the prompt metadata for relative-date resolution ("tomorrow", "Tuesday"). |
| `PORT` | no | `8787` | Listen port. |
| `DEBUG` | no | `0` | `1` → verbose logs **including transcript text**. Default 0: transcripts are NEVER logged. |
| `DRY_RUN` | no | `0` | `1` → no POSTs to Quo; intended task payloads are logged instead. The only mode to use against a real account during development. |
| `IDEMPOTENCY_FILE` | no | unset | Optional JSON file persisting the call-id set across restarts (callId + status + timestamp ONLY — no PII). Unset = in-memory LRU only. |
| `IDEMPOTENCY_MAX` | no | `5000` | LRU capacity (call ids). |
| `SIGNATURE_SKEW_SECONDS` | no | `300` | Replay window: reject signatures older/newer than this. |
| `ALLOW_UNSIGNED` | no | `0` | `1` → skip signature verification (LOCAL DEV ONLY; the server logs a warning every request). |
| `FALLBACK_POLL` | no | `0` | `1` → on `call.completed`, retry-poll the transcript endpoint. Only for accounts that can't subscribe to `call.transcript.completed`. Requires a long-running host. |
| `REPLAY_TOKEN` | no | unset | If set, enables `POST /replay` (manual re-run) gated by the `x-replay-token` header (constant-time compare). Also required by `backfill.mjs`. |
| `LEDGER_FILE` | no | unset | NDJSON append-log of filed tasks (metadata only, never transcripts). Powers dashboard drop stats, the digest, and offline visualization. |
| `DASHBOARD_TOKEN` | no | unset | If set, enables the read-only dashboard at `GET /dashboard?token=...`. |
| `DIGEST` | no | `0` | `1` → file one daily rollup task (filed / due-soon / dropped-with-reasons). Requires `LEDGER_FILE`. |
| `DIGEST_HOUR` | no | `17` | Hour (0–23, in `TIMEZONE`) after which the digest files. |
| `DIGEST_PHONE_NUMBER_ID` | no | first line | `PN...` id the digest task is linked to. |
| `SETUP_MODE` | no | `0` | `1` → guided onboarding wizard at `GET /setup`; boots with incomplete config. Localhost only — turn off after setup. |

## Beyond the webhook: the opt-in extras

All off by default — the stateless four-stage core never changes. Each is one or two env vars.

### Setup wizard (`SETUP_MODE=1`)

The guided alternative to editing `.env` by hand:

```bash
SETUP_MODE=1 node server.js
# open http://localhost:8787/setup
```

Four steps in the browser: validate your Quo key live (it lists your lines), get the exact webhook URL + secret field, test your LLM against a bundled sample call (including a prompt-injection attempt the pipeline should refuse), and download a generated `.env`. Keys are posted only to your local server to run the tests and are never stored. **Localhost only — remove `SETUP_MODE=1` once configured.**

### Dashboard (`DASHBOARD_TOKEN=...`)

Read-only view of every BackTalk task across **all lines**, grouped by call, at `https://<host>/dashboard?token=<value>`. Tasks are identified by the `Source: backtalk ref:` marker, so it works retroactively for everything BackTalk ever filed — no stored state needed. With a ledger configured it also shows what validation dropped in the last 7 days and why. In `DRY_RUN` (or keyless) setups it falls back to a ledger-only view so you can visualize what *would* be filed.

### Local ledger (`LEDGER_FILE=...`)

One JSON line per outcome (`task_created`, `task_logged`, `call_processed` with audit reasons, `digest_filed`). Task metadata only — the same text that already went to Quo — **never transcripts**. It's a convenience cache, not a source of truth; corrupt lines are skipped, and deleting the file is always safe.

### Daily digest (`DIGEST=1`, requires the ledger)

Once a day after `DIGEST_HOUR`, BackTalk files one rollup task: how many promises it filed from how many calls, what's due within 48h, and what validation dropped (with reasons). The point is trust — you see what the extraction layer did *and what it refused to do* without reading server logs.

### Backfill (`node backfill.mjs`)

Replays recent calls through a running server — for the day you installed BackTalk, or after downtime:

```bash
node backfill.mjs --since 7d --dry-run    # list what it would replay
node backfill.mjs --since 7d              # replay through the server's /replay
```

Needs `QUO_API_KEY` and `REPLAY_TOKEN` (env or `.env`; the token must also be set on the server). Idempotency and the `ref:` marker dedupe make re-runs safe — calls that already produced tasks are skipped.

### Eval harness (`node eval.mjs`)

Scores your model + prompt against the corpus in [`fixtures/eval/`](../fixtures/eval/) using the real extraction path: recall (did it find the spoken promises?), precision (did it invent extras?), and safety (did injection payloads leak into tasks?).

```bash
node eval.mjs                                      # configured model
node eval.mjs --model groq/llama-3.3-70b-versatile # compare a candidate
node eval.mjs --runs 3 --only injection            # variance on one case
```

Run it before switching models and before opening a prompt PR — if recall drops or the injection case leaks, you'll see it here first.

## Prerequisites & plan notes

- **Transcripts require a Quo Business or Scale plan.** No transcripts, no promises to catch.
- Subscribe the webhook to **`call.transcript.completed`** (preferred — payload carries the dialogue). `call.completed` carries metadata only.
- API key comes from your Quo workspace settings. Quirk worth knowing: the API expects the raw key in the `Authorization` header, **without** a `Bearer ` prefix.
