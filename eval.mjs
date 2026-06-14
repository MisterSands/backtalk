#!/usr/bin/env node
/**
 * eval.mjs — score a model/prompt combo against the fixture corpus.
 *
 * Runs every fixture in fixtures/eval/ through the REAL extraction path
 * (buildSystemPrompt → your configured LLM → parseAndValidate) and scores:
 *
 *   recall     — expected commitments that were found (quote + speaker + due)
 *   precision  — found commitments that were expected (extras are penalized)
 *   safety     — forbidden strings (injection payloads) appearing in any task
 *
 * This is how to compare models with evidence instead of vibes, and how to
 * verify a prompt change before opening a PR — if your change drops recall
 * or breaks the injection case, you'll see it here first.
 *
 * Usage (LLM config from env/.env, same vars as the server):
 *   node eval.mjs                       # all fixtures, configured model
 *   node eval.mjs --model groq/llama-3.3-70b-versatile
 *   node eval.mjs --runs 3              # repeat to observe variance
 *   node eval.mjs --only injection      # substring filter on fixture name
 *
 * Costs real tokens (one LLM call per fixture per run). No Quo key needed —
 * nothing is written anywhere.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  flattenTranscript,
  buildSystemPrompt,
  buildUserMessage,
  parseAndValidate,
  normalizeForMatch,
} from "./lib/extract.js";
import { chatJson } from "./lib/llm.js";

// ---------------------------------------------------------------- env/args

function loadDotEnv(file = path.join(process.cwd(), ".env")) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const args = { model: process.env.LLM_MODEL, runs: 1, only: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--model") args.model = process.argv[++i];
  else if (a === "--runs") args.runs = Math.max(1, Number(process.argv[++i]) || 1);
  else if (a === "--only") args.only = process.argv[++i];
  else if (a === "--help" || a === "-h") {
    console.log("usage: node eval.mjs [--model id] [--runs N] [--only name-substring]");
    process.exit(0);
  }
}

const provider = process.env.LLM_PROVIDER || "openai";
const baseUrl = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const apiKey = process.env.LLM_API_KEY;
if (!apiKey || !args.model) {
  console.error("LLM_API_KEY and LLM_MODEL (or --model) are required — same env contract as the server.");
  process.exit(1);
}

// ---------------------------------------------------------------- fixtures

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "eval");
const fixtures = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
  .filter((f) => !args.only || f.name.includes(args.only));

if (fixtures.length === 0) {
  console.error("no fixtures matched");
  process.exit(1);
}

// ---------------------------------------------------------------- scoring

function scoreRun(fixture, commitments) {
  const expected = fixture.expect ?? [];
  const matchedExpectations = new Set();
  const matchedCommitments = new Set();

  for (let e = 0; e < expected.length; e++) {
    const exp = expected[e];
    const needle = normalizeForMatch(exp.quote_contains);
    for (let c = 0; c < commitments.length; c++) {
      if (matchedCommitments.has(c)) continue;
      const com = commitments[c];
      if (!normalizeForMatch(com.verbatim_quote).includes(needle)) continue;
      if (exp.who && com.who !== exp.who) continue;
      if (exp.due === true && !com.due_iso) continue;
      matchedExpectations.add(e);
      matchedCommitments.add(c);
      break;
    }
  }

  const violations = [];
  for (const forbidden of fixture.forbid ?? []) {
    const needle = normalizeForMatch(forbidden);
    for (const com of commitments) {
      const haystack = normalizeForMatch(`${com.title} ${com.detail} ${com.verbatim_quote}`);
      if (haystack.includes(needle)) violations.push(forbidden);
    }
  }

  return {
    expected: expected.length,
    found: matchedExpectations.size,
    extras: commitments.length - matchedCommitments.size,
    violations,
  };
}

// ---------------------------------------------------------------- run

console.log(`model: ${args.model}  provider: ${provider}  runs: ${args.runs}\n`);
const totals = { expected: 0, found: 0, extras: 0, violations: 0, llmFailures: 0 };

for (const fixture of fixtures) {
  const flat = flattenTranscript(fixture.dialogue);
  const userMessage = buildUserMessage(
    { direction: "incoming", durationSeconds: 180, callDateIso: fixture.callDateIso, timezone: fixture.timezone ?? "UTC" },
    flat,
  );

  for (let run = 1; run <= args.runs; run++) {
    const r = await chatJson({ provider, baseUrl, apiKey, model: args.model, system: buildSystemPrompt(), user: userMessage });
    let line = `${fixture.name}${args.runs > 1 ? ` #${run}` : ""}`.padEnd(28);
    if (!r.ok) {
      totals.llmFailures += 1;
      console.log(`${line} LLM FAILED: ${r.error}`);
      continue;
    }
    const parsed = parseAndValidate(r.text, {
      transcriptFlat: flat,
      callDateIso: fixture.callDateIso,
      includeCaller: fixture.includeCaller === true,
      maxTasks: 8,
      minConfidence: "medium",
    });
    if (!parsed.ok) {
      totals.llmFailures += 1;
      console.log(`${line} VALIDATION FAILED: ${parsed.error}`);
      continue;
    }
    const s = scoreRun(fixture, parsed.commitments);
    totals.expected += s.expected;
    totals.found += s.found;
    totals.extras += s.extras;
    totals.violations += s.violations.length;
    const safety = s.violations.length ? `  SAFETY VIOLATION: ${s.violations.join(", ")}` : "";
    console.log(`${line} recall ${s.found}/${s.expected}  extras ${s.extras}${safety}`);
  }
}

const recall = totals.expected ? ((totals.found / totals.expected) * 100).toFixed(0) : "100";
const precisionDen = totals.found + totals.extras;
const precision = precisionDen ? ((totals.found / precisionDen) * 100).toFixed(0) : "100";
console.log(`\nTOTAL  recall ${recall}% (${totals.found}/${totals.expected})  precision ${precision}%  extras ${totals.extras}  safety violations ${totals.violations}  llm failures ${totals.llmFailures}`);
if (totals.violations > 0) process.exitCode = 1;
