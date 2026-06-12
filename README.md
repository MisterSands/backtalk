# BackTalk

**Every phone call ends with a promise. BackTalk files it as a task — before anyone forgets.**

A call wraps with *"I'll email you the quote tomorrow"* — and by next week it lives only in the customer's memory. BackTalk reads each call's transcript the moment it's ready, finds every spoken commitment, and drops it onto the right contact in [Quo](https://www.quo.com) (formerly OpenPhone) as a real task — dated, and quoted in the rep's own words. Nobody types a thing. No promise goes cold.

`MIT` · Works with Make, Zapier, n8n, or self-hosted · Bring your own AI (cloud or fully local)

![How BackTalk works: a call ends, the Quo webhook fires, an AI reads the transcript and finds the to-dos, and tasks are created on the same Quo contact — closing the loop](docs/backtalk_steps_diagram.svg)

---

## How do I install it? **Ask Claude.**

Seriously — that's the install method.

Open this repo in [Claude Code](https://claude.com/claude-code), or drop the link into [Claude](https://claude.ai), and say:

> **"Set up BackTalk for my Quo account."**

Claude reads the blueprint, builds the automation in your Make / Zapier / n8n (or self-hosts it), and walks you through connecting your Quo line and your AI key. **You bring the keys; Claude does the wiring.** First promise filed in minutes.

*No Claude handy? Every path is a few clicks by hand — see below.*

## What it can do

- **Catch every promise, automatically.** "I'll send that over," "I'll call you back Friday," "let me get you a quote" — each becomes a dated task on the right contact the instant the transcript lands.
- **Hear both sides.** Flip one setting and it also files what *the caller* promised, so you know exactly when to nudge.
- **Run on any AI you want.** OpenRouter, OpenAI, Anthropic, Groq — or fully local Ollama / LM Studio, so transcripts never leave your hardware.
- **Be the hook the rest of your stack hangs off.** It's open and yours to extend — fan promises out to a CRM, a Slack channel, or a daily "did it actually happen?" reconciliation.

Real tasks, linked to the call, with the due date when one was spoken. That's the whole idea.

## Wire it yourself

Prefer to build it by hand? Pick the tool you already use — each takes a few minutes:

| Tool | Start here |
|---|---|
| **Make** | Import [`blueprints/make-backtalk.blueprint.json`](blueprints/make-backtalk.blueprint.json) → [full guide](docs/make.md) |
| **n8n** | Import [`blueprints/n8n-backtalk.json`](blueprints/n8n-backtalk.json) → [guide](blueprints/README.md) |
| **Zapier** | [Step-by-step build](docs/zapier.md) |
| **Self-host** (Node, zero deps) | [`docs/self-hosting.md`](docs/self-hosting.md) |

You supply three things: your **Quo API key**, an **AI provider key**, and a Quo plan with **call transcripts** turned on.

## Try it in 30 seconds (no account needed)

```bash
git clone https://github.com/MisterSands/backtalk.git && cd backtalk
ALLOW_UNSIGNED=1 DRY_RUN=1 node server.js   # PowerShell: $env:ALLOW_UNSIGNED='1'; $env:DRY_RUN='1'; node server.js
# in another terminal:
curl -X POST localhost:8787/webhook -H "content-type: application/json" -d @fixtures/sample-webhook.json
```

You'll see the exact tasks it *would* file from a sample call. Going live, deploy details, and every config option live in [`docs/self-hosting.md`](docs/self-hosting.md).

## Privacy

Transcripts are **never stored** — read once to find the promises, then gone. They only ever reach the AI provider you choose (which can be your own machine via Ollama). Caller speech is treated as hostile input: a schema-locked prompt plus a deterministic validation layer (verbatim-quote grounding, enum whitelists, due-date sanity, URL/email/phone scrubbing) runs on every response. Self-hosted webhooks are signature-verified and fail closed. Full threat model in [SECURITY.md](SECURITY.md).

BackTalk only ever *creates tasks* — it never sends messages, edits contacts, or touches anything else in your account. Not affiliated with or endorsed by Quo/OpenPhone.

## Beyond the hook

Built and maintained by **Business Coconut** — [www.MrSands.com](https://www.MrSands.com). Hosted BackTalk, vertical prompt packs (legal intake, contracting, real estate), and multi-system routing with daily did-it-actually-happen reconciliation are the kind of thing I build for clients — reach out at [csands@gmail.com](mailto:csands@gmail.com).

## License

[MIT](LICENSE) — © BackTalk contributors.
