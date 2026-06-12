# BackTalk on Make (no-code path)

Make is the friendlier no-coder path for BackTalk. There's a native Quo/OpenPhone trigger, and the LLM and Tasks legs are ordinary HTTP modules you configure with dropdowns and fields — no code.

There are **two ways to get the wired scenario into your account**. Both end with the same module graph:

```
[Watch new call transcripts]  →  [HTTP: LLM extract]  →  [HTTP: POST /v1/tasks]
```

- **Option 1 — Use this scenario (shared link).** Once the maintainer has published the public scenario-sharing link, you preview it in your browser, then copy it into your account in one click. **Recommended for most people once the link is live** — until then, use Option 2.
- **Option 2 — Import the blueprint (.json file).** You download `blueprints/make-backtalk.blueprint.json` and import it. Good if you want a versioned file or air-gapped distribution.

**Neither option is "one click then done."** Both land the *wiring* fast, but **neither carries connections, API keys, or credentials** — Make's docs are explicit that a shared scenario "excludes API keys, passwords, and other details used to create a connection," and that blueprint importers "still need to create connections for their accounts after importing." So after either gesture, you authorize your Quo connection and paste a couple of keys before the first run. Honest framing: **one click to get the wiring, then 2–4 paste/authorize steps.**

All sample data here is fictional: Alex Agent / Casey Caller, `+1555555xxxx` numbers, `ACfictional…` ids.

---

## Option 1 — Use this scenario (shared link)

1. **Open the link** the maintainer gave you. The public scenario page renders in your browser — title, description, and an interactive preview — **with no Make account required**. You can see exactly what it does before committing.
2. **Click to copy it.** If you're logged in to Make, a **copy of the scenario is created in your account**. If you're not logged in, Make prompts you to sign in/up first, then copies it. *(The link always serves the maintainer's latest saved version, so you get the current build.)* Works on **all Make plans**.
3. Continue with **"After you have the scenario"** below.

The single in-app click ("a copy of the scenario will be created in your account") is the real one-click part. What follows is the same connect/paste work as Option 2.

---

## Option 2 — Import the blueprint (.json)

1. **Download** `blueprints/make-backtalk.blueprint.json` from the repo.
2. In Make: **Create a new scenario** → open the **three-dots menu** (top of the scenario builder) → **Import Blueprint** → **Choose file** → pick the `.json` → **Save**.
   - That gesture is genuinely one action, and per Make's docs the blueprint restores "modules, settings, and mapped values." It does **not** restore connections or keys.
3. Continue with **"After you have the scenario"** below.

---

## After you have the scenario (both options)

Whichever way you landed the scenario, the credentials and a few account-specific values are missing. Fill them in:

1. **Create / authorize the OpenPhone (Quo) connection.** Generate an API key in **Quo Settings → API** (requires **Owner/Admin** permissions on the workspace) and **paste it into Make** to create the connection. *(Connections and credentials are never inside a shared scenario or a blueprint — this step is unavoidable.)*
2. **Re-select that connection inside the trigger.** Open the **"Watch new call transcripts"** module and point its connection dropdown at the connection you just made. Imported/copied modules reference a connection that doesn't exist in your account, so the dropdown will be empty until you re-point it. This trigger fires on **completed transcripts**, and its output carries the actual who-said-what **`dialogue`** array (each segment has `content`, `start`, `end`, `identifier` = speaker phone number, and `userId`).
3. **Paste the Quo API key into the Tasks HTTP module.** Open the **HTTP POST → `https://api.openphone.com/v1/tasks`** module and set the **`Authorization` header to your raw Quo API key** — **no `Bearer ` prefix**. The documented format is literally `Authorization: YOUR_API_KEY`; a `Bearer` prefix returns 401. Make's HTTP "Make a request" module supports a custom raw header natively, so this is a no-code field, not code.
4. **Paste the LLM provider key into the LLM HTTP module.** Open the **HTTP module that calls your LLM** and set its `Authorization` header (e.g. `Bearer <your-LLM-key>` for OpenAI-compatible endpoints). Adjust the URL/model if you're not using the default endpoint.
5. **Fill any placeholder/account-specific values.** Set your target `phoneNumberId`, the task assignee/user id, and any other blank fields. Use `+1555555xxxx`-style placeholders until you have the real values. Edit the timezone line in the LLM module's user message so "tomorrow" / "Tuesday" resolve correctly.
6. **Turn the scenario ON.** Imported and copied scenarios arrive **inactive** — flip scheduling to instant/active.

Sample task body the Tasks HTTP module sends (fictional):

```json
{
  "title": "Send the updated fee schedule",
  "description": "Email the updated fee schedule to the caller\nQuote: \"I'll email you the updated fee schedule tomorrow morning.\"\nSource: backtalk ref:ACfictional0000000001",
  "activityId": "ACfictional0000000001",
  "dueDate": "2026-06-12T09:00:00-05:00"
}
```

---

## Honest caveats

- **Import / copy is NOT the whole setup.** Getting the wired module graph is one action; **before it runs** you create the Quo connection, re-point the trigger, and paste two keys (Quo + LLM). Claim "one step" **only** for the import/copy gesture itself, never for the whole setup.
- **Connections and keys are never in a blueprint or a shared scenario.** Make excludes "API keys, passwords, and other details used to create a connection." You always bring your own Quo API key and your own LLM key.
- **The raw `Authorization` header, not Bearer.** For the Tasks call to Quo, the header value is the **raw API key**. Setting it in the Basic Auth field or prepending `Bearer ` fails with 401.
- **Trigger is webhook/instant-capable.** Quo/OpenPhone natively supports a `call.transcript.completed` webhook, which is the mechanism instant triggers use, so a webhook-backed instant trigger is supported. Some third-party listings imply the transcript trigger can also poll on a schedule (customizable in ~15-minute intervals). State it as "webhook/instant trigger available" rather than assuming an explicit INSTANT badge on the module card.
- **Plan requirement on the Quo side.** Transcripts require a **Quo Business plan or higher** — no transcripts, nothing for BackTalk to catch.
- **The "Use this scenario" link only exists once the maintainer publishes it.** Until then, use the blueprint import (Option 2). Don't treat a not-yet-published link as a live one-click button.
- **Make is the least-hardened path.** The HTTP-only Make build does not run BackTalk's full validation layer (no URL/email/phone exfil scrub, no injection lint, no due-date window check, no dedupe store by default). If a transcript can contain hostile speech — and it can, since anyone who calls you can speak instructions at your LLM — run the **Node server in the repo root** instead. See `blueprints/README.md` for the module-by-module limitations.

---

## For the maintainer — publishing the "Use this scenario" link

This is the no-coder hero. Per Make's scenario-sharing docs:

1. Open (or save) the finished scenario in the builder.
2. Click **Share** in the **upper-right corner** of the scenario builder.
3. Toggle on the **"Public scenario page"** option to generate a shareable URL.
4. Optionally customize the public **title / description / thumbnail**.
5. **Copy the link** and paste it into the README's "Use this scenario" button.

Why prefer this over shipping the raw blueprint `.json`:

- The recipient can **preview the automation in-browser with zero account**, which lowers the trust barrier.
- Copying is a **single in-app click** — no file download/upload step.
- The link **always serves your latest saved version**, so you can ship fixes without re-publishing a file.
- It works on **all Make plans.**

Blueprint import stays as the fallback for users who want a versioned file or air-gapped distribution. **Both still require the user to add their own Quo connection and paste their API keys afterward** — neither eliminates that, and the README copy must say so.

> Make also has a separate **scenario-templates** gallery system, but publishing to that gallery is **partner-reviewed/gated**, not a self-serve one-click for an individual. The self-serve hero is the **public scenario-sharing link** above, not a gallery template. There is **no BackTalk CLI** — the entire no-coder path is the Make GUI (copy a shared scenario link or import a `.json`) plus pasting your keys.
