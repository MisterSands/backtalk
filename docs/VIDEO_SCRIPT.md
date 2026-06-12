# Explainer video — corrected "connect" scene

Maintainer-facing. This doc is the production reference for the BackTalk explainer video. It exists to **replace one wrong shot** and to give the editor an honest, no-coder-first storyline, headline options, and the reasoning behind the fix.

The single most important rule: **claim "one click" only for the click that is literally one click** (copying the template), and **show the connect/paste steps that follow** instead of hiding them. Everything below is written so the finished video never overclaims.

All names, numbers, and ids in this doc are fictional: Acme Plumbing, Alex Agent, Casey Caller, `+1555555xxxx` numbers, `ACfictional…` ids.

---

## 1. The corrected "Connect in one step" scene

This scene replaces the old shot of a terminal typing `backtalk connect --via zapier`. **There is no BackTalk CLI and no such command** — see the note in section 4 for why that shot was wrong.

The truthful one-click surface is a published **"Use this Zap"** button (Zapier) or a **"Use this scenario"** shared-link button (Make). Either one genuinely copies the whole pre-built workflow into the viewer's own account in a single click. What follows the click — connecting accounts and pasting a key or two — is shown honestly, never implied away.

Two variants are scripted below. **Variant B is the recommended one to shoot** — it keeps the real one-click promise *and* shows the two connections, so nobody hits a surprise. Variant A is the ultra-short cut for a tight runtime; if you use it, the caption stops at the click and does not claim the whole setup is one step.

The Make equivalent is identical staging — only the button label, destination editor, and connection screens change. **Do not show the download-JSON / Import Blueprint flow in this hero shot**; that is the slower path and belongs in the README's Advanced section, not the one-click promise.

### Variant A — ultra-minimal (recommended runtime: ~6s)

| Beat | On-screen action | Voiceover | On-screen caption |
|---|---|---|---|
| 1 | Cursor hovers a single bright button labeled **Use this Zap**. One click. | "No code. No server." | — |
| 2 | Screen wipes to the viewer's **own** Zapier editor with the BackTalk Zap already assembled: **Quo trigger → AI step → Create Task**. No typing, no terminal anywhere on screen. | "One click copies the whole workflow into your own Zapier." | **Connect in one click** |

Honesty guard for Variant A: the click genuinely copies the published template in one action, so the caption is true. The caption stops *at the click* — it must not say or imply the entire setup is one step, because connecting accounts still follows off-screen.

### Variant B — slightly more explanatory (recommended to shoot; ~12s) ⭐

| Beat | On-screen action | Voiceover | Lower-third caption |
|---|---|---|---|
| 1 | Cursor clicks the **Use this Zap** button. The Zap appears in the viewer's Zapier, fully wired: **Quo trigger → AI → Create Task**. | "One click copies the Zap into your Zapier." | **1 · Copy the Zap** |
| 2 | Two quick connect screens flash by — **"Connect Quo"** (account auth) and **"Connect your AI"** (a single key field). Each is one field, shown briefly so the viewer sees there *are* two connections. | "Connect your Quo line and your AI provider — that's two logins and one key —" | **2 · Connect your 2 accounts** |
| 3 | A green **Publish / turn-on** toggle flips on. Cut to a Quo call screen: a task **"Send the updated fee schedule"** pops onto the call. | "— then flip it on. Your calls start filing their own follow-ups." | **3 · Turn it on** |

Closing card caption (full): **1 Copy. 2 Connect. 3 Done. (No code, no server.)**

Honesty guard for Variant B: this is truthful because it shows the copy is one click **and** that two account connections plus one pasted key follow before anything runs. Never show or imply a `backtalk connect` command — it does not exist.

### Make equivalent (either variant)

Identical staging. Swap:

- Button label → **Use this scenario**
- Destination → the **Make scenario editor** (the wired graph: **Watch new call transcripts → AI/HTTP step → Create Task via HTTP POST**)
- Connect screens → Make's **Quo connection** and the **HTTP / AI provider key** field

Do **not** show the three-dots → Import Blueprint → choose-file flow in the hero. That is the more-steps path; it lives in Advanced.

### What you may NOT show in this scene

- ❌ A terminal / command prompt of any kind.
- ❌ `backtalk connect --via zapier` or any `backtalk <subcommand>` — there is no BackTalk CLI.
- ❌ A caption that says the *whole setup* is "one step" or "one click." Only the copy gesture is one click.
- ❌ The Make Import-Blueprint (download JSON) flow as if it were the one-click path.

### Honest footnote the video should not contradict (say it, or at least don't deny it)

Even in the best case, after the one-click copy the viewer still: (a) connects their **own** Quo account with an API key, (b) connects/authorizes the **AI** step (a built-in AI model needs no key; ChatGPT/your own model needs a pasted key), and on Zapier specifically (c) the Tasks leg uses **Webhooks by Zapier → Custom Request**, whose config (URL, method, headers, body) **does not travel in a template** and must be rebuilt by hand. The hero shot doesn't have to dwell on (c), but the README and any "full setup" follow-up must. Templates copy the *steps and app selections* but **never the field values or your keys**.

---

## 2. No-coder explainer storyline (5 beats)

A tight, plain-English arc for the full video. No jargon, no terminal, fictional throughout.

**Beat 1 — The dropped promise (the hook).**
It's 4:50 on a Friday at Acme Plumbing. Alex Agent wraps a call with Casey Caller: *"I'll send you the updated fee schedule tomorrow morning."* The line goes dead, the phone rings again, and by Monday that promise lives only in Casey's head — and Casey is the one who notices it was broken.
*Visual:* a phone hangs up; a sticky note labeled "fee schedule" flutters off a desk and out of frame.

**Beat 2 — The one-click connect.**
"There's a fix, and it's not code." Cursor clicks **Use this Zap** (or **Use this scenario**). The pre-built BackTalk workflow drops into the viewer's own Zapier/Make. Then two quick connect screens — Quo, and your AI provider.
*Visual:* the Variant B scene from section 1.

**Beat 3 — The live payoff (call ends → task appears).**
A new call ends. A transcript icon ticks to "ready." A task **"Send the updated fee schedule"** — due tomorrow morning, Alex's exact words quoted underneath — slides onto the Quo call. Nobody typed anything.
*Visual:* split second between "call ended" and "task created," same contact, linked.

**Beat 4 — Bring-your-own-AI / privacy line.**
"Your call transcripts only ever go to the AI provider *you* choose — OpenRouter, OpenAI, Anthropic, Groq, or your own machine with Ollama. BackTalk stores nothing." One line, plain.
*Visual:* a small lock; a row of provider names; a "stored: nothing" tag.

**Beat 5 — CTA to Business Coconut.**
"BackTalk is open source and free. Want the hosted version, prompt packs for your industry, or daily did-it-actually-happen reconciliation? That's what Business Coconut builds."
*Visual:* the wordmark **Business Coconut** and **www.MrSands.com**.

---

## 3. Headline options (4, all honest)

Pick one for the title card / thumbnail. All four are true to what BackTalk does and do not overclaim the setup.

1. **No code. No server. Your phone calls file their own follow-ups.**
2. **Every call ends with a promise. BackTalk turns it into a Quo task — no code, no server, one click to copy the workflow.**
3. **Copy one Zap. Connect two accounts. Never drop a spoken promise again.**
4. **Your AI listens to the call so nobody has to remember the follow-up — set it up in your browser, no terminal required.**

Notes for whoever picks: #1 is the cleanest thumbnail line. #2 is the most complete promise but longest. #3 mirrors the Variant B "1 Copy / 2 Connect / 3 Done" rhythm. #4 leads with the privacy/BYO-AI angle.

---

## 4. Why the old CLI shot was wrong (read this before re-shooting)

The previous cut showed a terminal typing **`backtalk connect --via zapier`** under a "connect in one step" claim. That shot is false on two counts and has to go.

First, **the command is fiction.** BackTalk has no CLI and no `connect` subcommand — the only command-line surface that exists is `node server.js` for the self-host path, which is a developer concern and the opposite of the no-coder promise. Putting an invented command on screen tells a no-coder to open a terminal and type something that will simply error, and it misrepresents the product's actual surface. The real no-coder path is entirely a GUI: click a published **"Use this Zap" / "Use this scenario"** button (or, as the slower fallback, import a blueprint), then connect accounts and paste a key. Second, even the *idea* of "connect in one step via a command" is the wrong mental model: there is no single action — CLI or otherwise — that wires Quo to your AI to Quo Tasks and turns it on. The honest shape is **one click to copy the wiring, then two connections (and, on Zapier, a rebuilt Webhooks step) before the first run.** The corrected scene in section 1 keeps the genuine one-click moment (the template copy) and shows the connect steps that follow, so the video stays truthful for a non-developer instead of selling a command that doesn't exist.
