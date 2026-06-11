# Contributing

Thanks for helping make hang-ups less forgetful. The project is intentionally small; please keep it that way.

## Getting started

```bash
git clone <this-repo> talkback-quo
cd talkback-quo
npm test          # node:test — no network, no install, finishes in seconds
node server.js    # boots on :8787
```

There is no build step, no transpiler, no lockfile churn — because there are no packages.

## The rules

### 1. Zero dependencies. Zero.

- `dependencies`: none. `devDependencies`: none. Tests use `node:test`; everything else uses Node >= 20 built-ins (`node:http`, `node:crypto`, `node:fs`, `fetch`, `AbortSignal.timeout`).
- PRs that add a package will be asked to inline the few lines actually needed instead. The bar for an exception is "impossible with built-ins", not "easier with a package".

### 2. Fictional data only

This tool processes real phone calls in production, so the repo's hygiene matters:

- **Phone numbers:** only `+1555555xxxx` (e.g. `+15555550123`). No other number shapes, ever — including in comments and test names.
- **Emails/domains:** only `@example.com` / `example.com` (API hosts like `api.openphone.com` excepted where technically required).
- **Human names:** only the fictional roster — Alex Agent, Bailey Agent, Casey Caller, Dana Caller.
- **Company names:** "Acme Plumbing", "Northwind Realty".
- **Never** paste real transcripts, call ids, webhook payloads, API keys, or log excerpts from a live workspace into issues, PRs, fixtures, or commit messages. Recreate the shape with fictional data instead.

### 3. Live accounts are read-only

Development against a real Quo workspace happens only via `scripts/live-test.mjs` (GET-only by hard assertion) or with `DRY_RUN=1`. Never point an unguarded write path at a real account, including in CI.

### 4. Security invariants are not refactorable

These hold in every PR, no exceptions:

- LLM output never chooses an API target, model name, or endpoint — those come from the verified webhook payload and `.env` only.
- `parseAndValidate` stays deterministic (no model calls inside validation) and runs on every LLM response.
- Signature verification stays fail-closed and timing-safe.
- Speaker labels derive from `userId` / E.164 identifiers, never transcript content.
- Transcripts are never written to disk and never logged unless `DEBUG=1`.

If your change touches `lib/verify.js` or `lib/extract.js`, say so prominently in the PR description.

## Code style

- ESM (`"type": "module"`), Node >= 20.
- Import built-ins with the `node:` prefix (`import crypto from "node:crypto"`).
- Small pure functions; `lib/verify.js` and the validators take all inputs as arguments — no env reads inside.
- `lib/quo.js` never throws across its module boundary: every call returns `{ok, status, data, error}`.
- Parse defensively (tolerant JSON, typed coercion helpers); fail closed on anything security-relevant.
- Two-space indent, double quotes, semicolons — match the surrounding file.

## Tests

- `npm test` must pass with **no network**. Mock HTTP by monkey-patching `globalThis.fetch` inside the test (see `test/extract.test.js`).
- Behavior changes need a test. Validation changes need a negative test (prove the bad input is dropped, not just that good input passes).
- Fixtures live in `fixtures/` and follow the fictional-data rules above.

## Pull requests

- One concern per PR; small diffs review fast.
- Update `README.md` / `.env.example` / `docs/architecture.md` when you change the env contract or pipeline behavior.
- For security issues, **do not open a PR or issue** — see [SECURITY.md](SECURITY.md) for private reporting.
