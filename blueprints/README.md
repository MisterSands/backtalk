# Blueprints — n8n, Make, Zapier

Importable versions of the TalkBack pipeline for the three big automation platforms. All three run the same four stages as the Node server:

```
[webhook receive + verify] → [transcript acquire] → [LLM promise extraction] → [Quo Task creation]
```

**The Node server in the repo root is the reference implementation and the most hardened path.** The platform blueprints trade some of its Layer-2 validation for convenience. Here is the honest comparison:

| | Node server | n8n | Make | Zapier |
|---|---|---|---|---|
| Webhook signature verification | both schemes, timing-safe | both schemes, timing-safe (Code node) | handled by the Make OpenPhone connection | handled by the Zapier OpenPhone app |
| Groundedness check (quote must appear in transcript) | yes, normalized substring | yes, normalized substring | best-effort `contains()` filter | yes (Code step) |
| URL / email / phone exfil scrub | yes | yes | **no** (only quote/control-char stripping for JSON safety) | yes (Code step) |
| Due-date sanity window (call date → +365 d) | yes | yes | **no** | yes (Code step) |
| Injection lint on task text | yes | yes | **no** | yes (Code step) |
| Dedupe across redeliveries | call-id claim + effect-level `ref:` marker | workflow static data (last 1000 call ids) | **none by default** | optional Storage by Zapier |
| Max tasks per call | 8 (hard ceiling) | 8 (hard ceiling) | 8 (iterator index cap) | 8 (Code step) |

If a transcript can contain hostile speech (it can — anyone who calls you can talk instructions at your LLM), prefer the Node server. The Make path in particular has the weakest validation layer; treat it as a convenience build, not a hardened one.

All example data in these files is fictional: names like Alex Agent and Casey Caller, numbers like `+15555550123`, ids like `ACfictional0000000001`.

---

## n8n — `n8n-talkback.json`

Generic nodes only (Webhook, Code, IF, HTTP Request, Respond to Webhook) — no community nodes to install.

### Import

1. n8n → **Workflows → Import from File** → pick `n8n-talkback.json`.
2. Set the environment variables below on the n8n **host** (container env, not inside n8n).
3. **Activate** the workflow and copy the production webhook URL (`…/webhook/talkback`).
4. In the **Quo dashboard**, create a webhook pointing at that URL, subscribed to **`call.transcript.completed` only** — its payload carries the full dialogue, so the workflow never has to call back for the transcript.
5. Paste the webhook's signing key into `QUO_WEBHOOK_SECRET`. If you register more than one webhook, comma-separate the secrets.

### Environment variables

| Var | Required | Default | Meaning |
|---|---|---|---|
| `QUO_API_KEY` | yes | — | Quo API key. Sent **raw** in the `Authorization` header — no `Bearer` prefix. |
| `QUO_WEBHOOK_SECRET` | yes | — | Signing secret(s), comma-separated. `whsec_…` values route to the beta scheme automatically. |
| `LLM_API_KEY` | yes | — | Key for your OpenAI-compatible provider (any non-empty string for Ollama / LM Studio). |
| `LLM_MODEL` | yes | — | e.g. `anthropic/claude-haiku-4.5` — any chat model that can follow a JSON schema works. |
| `LLM_BASE_URL` | no | `https://openrouter.ai/api/v1` | Ollama: `http://localhost:11434/v1`. |
| `MIN_CALL_SECONDS` | no | `30` | Skip shorter calls before any LLM spend. |
| `MAX_TASKS_PER_CALL` | no | `8` | Hard ceiling 8 — may be lowered, never raised. |
| `MAX_TRANSCRIPT_CHARS` | no | `24000` | 60% head + 40% tail cap with a `[... middle trimmed ...]` marker. |
| `MIN_CONFIDENCE` | no | `medium` | Drop commitments below this (`low`/`medium`/`high`). |
| `INCLUDE_CALLER_COMMITMENTS` | no | `0` | `1` → also file the caller's commitments. |
| `OWNED_NUMBERS` | no | unset | `+15555550100=Alex Agent,+15555550101=Bailey Agent` — these identifiers are forced to AGENT (forwarded-line edge case). |
| `QUO_DEFAULT_ASSIGNEE` | no | unset | `US…` user id stamped on every created task. |
| `TIMEZONE` | no | `UTC` | IANA timezone fed to the prompt for resolving "tomorrow" / "Tuesday". |
| `SIGNATURE_SKEW_SECONDS` | no | `300` | Replay window for signature timestamps. |
| `ALLOW_UNSIGNED` | no | `0` | `1` skips signature checks. **Local testing only.** |

### Platform notes (read these — they bite)

- **The `Authorization` header to `api.openphone.com` is the raw key — no `Bearer` prefix.** The "Create Quo Task" node is already wired that way; don't "fix" it. (The LLM node *does* use `Bearer` — that one is correct too.)
- **Keep "Raw Body" enabled on the Webhook node.** Signature verification needs the exact request bytes.
- The Code nodes use `require('crypto')`. If your instance restricts builtins, set `NODE_FUNCTION_ALLOW_BUILTIN=crypto`. If `$env` reads are blocked, make sure `N8N_BLOCK_ENV_ACCESS_IN_NODE` is not `true`.
- **Dedupe uses workflow static data**, which only persists for *active* (production) executions and lives in this one n8n instance. Manual test runs always start with an empty seen-list.
- If a call yields **zero surviving commitments**, the run ends before the "Respond OK" node; n8n then sends its default webhook response (still a 2xx, so the provider will not retry). Harmless, but don't be surprised by the editor warning.
- A failed signature check **throws**, which returns a 5xx to the provider. That is intentional: a forged delivery dies, a genuinely misconfigured secret shows up loudly in your executions list.
- One failed task-create does not kill the batch ("Create Quo Task" continues on error). Check the execution log for per-item failures.
- **Test before going live:** temporarily set `ALLOW_UNSIGNED=1`, then POST the repo's `fixtures/sample-webhook.json` at the test webhook URL and watch the execution. Set it back to `0` after.

---

## Make — `make-talkback.blueprint.json`

Uses Make's **native OpenPhone "Watch New Call Transcripts" instant trigger** — the OpenPhone connection registers and authenticates the webhook for you, which sidesteps manual HMAC verification (Make has no code module to do it). The LLM and Quo Tasks legs are raw HTTP modules, so you can point the LLM at any OpenAI-compatible endpoint.

### Import

1. Make → **Scenarios → Create a new scenario → ⋯ → Import Blueprint** → pick `make-talkback.blueprint.json`.
2. Open the trigger module and attach/create your **OpenPhone connection + webhook** (the import cannot carry a webhook across accounts).
3. Open **"LLM Extract (OpenAI-compatible)"** and replace `<<PASTE_YOUR_LLM_API_KEY>>` in the Authorization header. Adjust the URL and the `"model"` field in the body if you are not using the default endpoint/model.
4. Open **both** "Create Quo Task" modules (with / without due date) and replace `<<PASTE_YOUR_QUO_API_KEY>>`. That header is the **raw key — no `Bearer` prefix**.
5. In the LLM module's body, edit the `- timezone: UTC` line in the user message to your IANA timezone so "tomorrow" resolves correctly.
6. Turn the scenario on.

### How it maps

| Stage | Modules |
|---|---|
| Receive | OpenPhone instant trigger (transcript payload arrives complete) |
| Flatten | Iterator over `dialogue` → Text Aggregator (`AGENT:` / `CALLER:` lines from `userId` only) → Set variables (`callId`, capped `transcriptFlat`, `durationOk`) |
| Extract | HTTP POST to `…/chat/completions` (filter: duration ≥ 30, transcript non-empty, status `completed`) → Parse JSON → Iterator over `commitments` |
| File | Router (filter: `who = agent`, `confidence ≠ low`, quote length > 15, quote contained in transcript, max 8 items) → HTTP POST `/v1/tasks`, two variants: with `dueDate` (ISO-shape checked + sanitized) / without |

Two task modules exist because the Quo API requires the `dueDate` key to be **omitted** (not null or empty) when no date was spoken, and Make cannot conditionally drop a key from a raw JSON body.

To also file the **caller's** commitments, edit the router filter and remove the `who = agent` condition (or change it to your taste).

### Honest limitations (this is the least-hardened path)

- **No URL/email/phone exfil scrub and no injection lint.** The aggregator strips double quotes, backslashes and control characters (for JSON safety), and the groundedness filter (`contains()`) blocks fabricated quotes — but a phone number smuggled into a *real* spoken promise will land in the task text.
- **No due-date window check.** A route filter requires `due_iso` to *look like* an ISO 8601 date-time (anything else files the task without a due date), and the value is quote/control-character sanitized before it enters the JSON body — but a well-formed date in 1999 will still be sent.
- **No dedupe store by default.** If Make redelivers or you re-run, you get duplicate tasks. If you observe redeliveries, add a **Data Store** keyed on `callId` right after the trigger and filter out already-seen ids.
- Groundedness is a best-effort `contains()` on the sanitized transcript — weaker than the Node server's normalized-substring check.
- If your model wraps JSON in code fences despite `response_format`, the Parse JSON module strips ``` fences, but heavy prose around the JSON will still fail the parse.

**If any of that matters for your calls, run the Node listener instead** — it is ~200 lines of dependency-free code and does all of it.

---

## Zapier

Zaps are not cleanly exportable, so Zapier gets a step-by-step build guide instead of an import file: see [`../docs/zapier.md`](../docs/zapier.md).

---

## Credential / setting mapping across platforms

| Concept | Node server (`.env`) | n8n | Make | Zapier |
|---|---|---|---|---|
| Quo API key | `QUO_API_KEY` | `QUO_API_KEY` env | Authorization header in both task modules | Authorization header in the task webhook step |
| Webhook authenticity | `QUO_WEBHOOK_SECRET` | `QUO_WEBHOOK_SECRET` env | OpenPhone connection (managed) | OpenPhone app trigger (managed) |
| LLM endpoint | `LLM_BASE_URL` | `LLM_BASE_URL` env | URL in "LLM Extract" module | URL in the LLM webhook step |
| LLM key | `LLM_API_KEY` | `LLM_API_KEY` env | Bearer header in "LLM Extract" | Bearer header in the LLM step |
| Model id | `LLM_MODEL` | `LLM_MODEL` env | `"model"` in the request body | `model` in the Code step |
| Timezone | `TIMEZONE` | `TIMEZONE` env | edit the user-message line | `timezone` input on the Code step |

One spirit-level rule everywhere: **the only write this tool ever performs against your Quo account is `POST /v1/tasks`.** It never sends messages, never touches contacts, and never registers webhooks on your behalf (you — or the platform connection you authorize — create those).
