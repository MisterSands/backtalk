# Blueprints — n8n, Make, Zapier

Importable versions of the BackTalk pipeline for the three big automation platforms. All three run the same four stages as the Node server:

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

## n8n — `n8n-backtalk.json`

Generic nodes only (Webhook, Set, Code, IF, HTTP Request, Respond to Webhook) — no community nodes to install.

☁️ **n8n Cloud works out of the box via the Config node; host env vars are the self-host alternative.** Nothing in the workflow *requires* access to host environment variables.

### Import

1. n8n → **Workflows → Import from File** → pick `n8n-backtalk.json`.
2. Create the two **Header Auth credentials** the HTTP nodes reference — after import they show as *credential not found*:
   - **"Quo API (raw key)"** → Name: `Authorization`, Value: your Quo API key, **raw — no `Bearer` prefix** (used by "Create Quo Task").
   - **"LLM API (Bearer)"** → Name: `Authorization`, Value: `Bearer <your LLM key>` — type the literal word `Bearer` plus a space (any non-empty key for Ollama / LM Studio; used by "LLM Extract").
3. Open the **Config** node and review the settings (table below). At minimum check `llmModel` and `timezone`.
4. **Activate** the workflow and copy the production webhook URL (`…/webhook/backtalk`).
5. In the **Quo dashboard**, create a webhook pointing at that URL, subscribed to **`call.transcript.completed` only** — its payload carries the full dialogue, so the workflow never has to call back for the transcript.
6. Paste the webhook's signing key into the Config node's `webhookSecret` field. If you register more than one webhook, comma-separate the secrets. (Self-host alternative: leave the field empty and set the `QUO_WEBHOOK_SECRET` env var on the n8n host.)

### Secrets — where each one lives

| Secret | Where it goes | Notes |
|---|---|---|
| Quo API key | **Credential** "Quo API (raw key)" | Sent **raw** in the `Authorization` header — no `Bearer` prefix. |
| LLM API key | **Credential** "LLM API (Bearer)" | Credential value is `Bearer <key>` — the prefix is typed into the credential. |
| Quo webhook signing secret | **Config node** `webhookSecret` (n8n Cloud) or `QUO_WEBHOOK_SECRET` host env var (self-host) | Code nodes cannot read n8n credentials, so this one secret cannot live in a credential. If you put it in the Config node, the workflow JSON contains it — keep the workflow private and strip the field before sharing an export. `whsec_…` values route to the beta scheme automatically. |

### Settings (the Config node)

All non-secret settings live in the **Config** Set node, right after the webhook — edit them there. On **self-host**, the env var in the right-hand column (set on the n8n host) overrides the Config value when present, so the old env-var contract still works. On **n8n Cloud** the env override simply never fires — env reads are wrapped in a safe fallback, so a blocked `$env` cannot break the workflow.

| Config field | Default | Meaning | Self-host env override |
|---|---|---|---|
| `minCallSeconds` | `30` | Skip shorter calls before any LLM spend. | `MIN_CALL_SECONDS` |
| `maxTasksPerCall` | `8` | Hard ceiling 8 — may be lowered, never raised. | `MAX_TASKS_PER_CALL` |
| `maxTranscriptChars` | `24000` | 60% head + 40% tail cap with a `[... middle trimmed ...]` marker. | `MAX_TRANSCRIPT_CHARS` |
| `minConfidence` | `medium` | Drop commitments below this (`low`/`medium`/`high`). | `MIN_CONFIDENCE` |
| `includeCallerCommitments` | `false` | `true` → also file the caller's commitments. | `INCLUDE_CALLER_COMMITMENTS` (`1`/`0`) |
| `ownedNumbers` | empty | `+15555550100=Alex Agent,+15555550101=Bailey Agent` — these identifiers are forced to AGENT (forwarded-line edge case). | `OWNED_NUMBERS` |
| `timezone` | `America/New_York` | IANA timezone fed to the prompt for resolving "tomorrow" / "Tuesday". | — (Config only) |
| `signatureSkewSeconds` | `300` | Replay window for signature timestamps. | `SIGNATURE_SKEW_SECONDS` |
| `allowUnsigned` | `false` | `true` skips signature checks. **Local testing only.** | `ALLOW_UNSIGNED` (`1`/`0`) |
| `defaultAssignee` | empty | `US…` user id stamped on every created task. | `QUO_DEFAULT_ASSIGNEE` |
| `llmBaseUrl` | `https://openrouter.ai/api/v1` | Ollama: `http://localhost:11434/v1`. | — (Config only) |
| `llmModel` | `anthropic/claude-haiku-4.5` | Any chat model that can follow a JSON schema works. | — (Config only) |
| `webhookSecret` | empty | **Secret** — see the secrets table above. | `QUO_WEBHOOK_SECRET` |

### Platform notes (read these — they bite)

- **The `Authorization` header to `api.openphone.com` is the raw key — no `Bearer` prefix.** The "Quo API (raw key)" credential is wired that way; don't "fix" it. (The LLM credential *does* carry `Bearer` in its value — that one is correct too.)
- **Keep "Raw Body" enabled on the Webhook node.** Signature verification needs the exact request bytes. The Config node passes binary through ("Strip Binary Data" is off) — leave that alone too.
- **Self-host only:** the Code nodes use `require('crypto')` — if your instance restricts builtins, set `NODE_FUNCTION_ALLOW_BUILTIN=crypto`. n8n Cloud already allows `crypto`, and `$env` reads are wrapped in a try/catch fallback, so a blocked `$env` (n8n Cloud, or `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`) just means the Config node values are used.
- **Dedupe uses workflow static data**, which only persists for *active* (production) executions and lives in this one n8n instance. Manual test runs always start with an empty seen-list.
- If a call yields **zero surviving commitments**, the run ends before the "Respond OK" node; n8n then sends its default webhook response (still a 2xx, so the provider will not retry). Harmless, but don't be surprised by the editor warning.
- A failed signature check **throws**, which returns a 5xx to the provider. That is intentional: a forged delivery dies, a genuinely misconfigured secret shows up loudly in your executions list.
- One failed task-create does not kill the batch ("Create Quo Task" continues on error). Check the execution log for per-item failures.
- **Test before going live:** temporarily set `allowUnsigned` to `true` in the Config node (or `ALLOW_UNSIGNED=1` on self-host), then POST the repo's `fixtures/sample-webhook.json` at the test webhook URL and watch the execution. Set it back to `false` after.

---

## Make — `make-backtalk.blueprint.json`

Uses Make's **native OpenPhone "Watch New Call Transcripts" instant trigger** — the OpenPhone connection registers and authenticates the webhook for you, which sidesteps manual HMAC verification (Make has no code module to do it). The LLM and Quo Tasks legs are raw HTTP modules, so you can point the LLM at any OpenAI-compatible endpoint. Full setup guide: [`../docs/make.md`](../docs/make.md).

### Import

1. Make → **Scenarios → Create a new scenario → ⋯ → Import Blueprint** → pick `make-backtalk.blueprint.json`.
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
| Quo API key | `QUO_API_KEY` | "Quo API (raw key)" credential | Authorization header in both task modules | Authorization header in the task webhook step |
| Webhook authenticity | `QUO_WEBHOOK_SECRET` | Config node `webhookSecret` (or `QUO_WEBHOOK_SECRET` env, self-host) | OpenPhone connection (managed) | OpenPhone app trigger (managed) |
| LLM endpoint | `LLM_BASE_URL` | Config node `llmBaseUrl` | URL in "LLM Extract" module | URL in the LLM webhook step |
| LLM key | `LLM_API_KEY` | "LLM API (Bearer)" credential | Bearer header in "LLM Extract" | Bearer header in the LLM step |
| Model id | `LLM_MODEL` | Config node `llmModel` | `"model"` in the request body | `model` in the Code step |
| Timezone | `TIMEZONE` | Config node `timezone` | edit the user-message line | `timezone` input on the Code step |

One spirit-level rule everywhere: **the only write this tool ever performs against your Quo account is `POST /v1/tasks`.** It never sends messages, never touches contacts, and never registers webhooks on your behalf (you — or the platform connection you authorize — create those).
