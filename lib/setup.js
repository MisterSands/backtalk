/**
 * lib/setup.js — web-based onboarding wizard. SETUP_MODE=1 only.
 *
 * Routes:
 *   GET  /setup           → wizard HTML
 *   POST /setup/api/quo   → {apiKey} → validates the key live (GET /phone-numbers,
 *                            read-only) and returns the workspace's lines
 *   POST /setup/api/llm   → {provider, baseUrl, apiKey, model} → runs the bundled
 *                            sample call through the REAL pipeline (prompt → LLM →
 *                            Layer-2 validation) and returns the would-be tasks
 *
 * The generated .env is assembled in the browser and downloaded as a file —
 * this module never writes config to disk and never stores the posted keys.
 * Keys travel browser → this local server → the provider you're testing, and
 * exist only for the duration of the request.
 *
 * SETUP_MODE relaxes the boot requirement for LLM/Quo config (the wizard
 * exists to produce those values). Run it on localhost, finish setup, then
 * turn it off. The server prints a warning while it's on.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createQuoClient } from "./quo.js";
import { chatJson } from "./llm.js";
import {
  flattenTranscript,
  buildSystemPrompt,
  buildUserMessage,
  parseAndValidate,
  buildTaskPayload,
} from "./extract.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sample-webhook.json");

async function testQuo(body) {
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!apiKey) return { code: 400, body: { ok: false, error: "apiKey required" } };
  const quo = createQuoClient({ apiKey });
  const r = await quo.listPhoneNumbers();
  if (!r.ok) {
    const hint =
      r.status === 401 || r.status === 403
        ? "Key rejected. Copy it from Quo workspace settings → API. (BackTalk sends it raw — no Bearer prefix — that part is handled for you.)"
        : `Quo API returned ${r.status}.`;
    return { code: 200, body: { ok: false, error: r.error, hint } };
  }
  const lines = (r.data?.data ?? []).map((p) => ({
    id: p.id,
    name: p.name || p.number,
    number: p.number,
    users: (Array.isArray(p.users) ? p.users : []).map((u) => ({
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id,
    })),
  }));
  return { code: 200, body: { ok: true, lines } };
}

async function testLlm(body) {
  const provider = body?.provider === "anthropic" ? "anthropic" : "openai";
  const baseUrl = String(body?.baseUrl ?? "https://openrouter.ai/api/v1").trim();
  const apiKey = String(body?.apiKey ?? "").trim();
  const model = String(body?.model ?? "").trim();
  if (!apiKey || !model) return { code: 400, body: { ok: false, error: "apiKey and model required" } };

  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  } catch {
    return { code: 500, body: { ok: false, error: "sample fixture missing" } };
  }
  const t = fixture.data.object;
  const flat = flattenTranscript(t.dialogue);
  const userMessage = buildUserMessage(
    { direction: "incoming", durationSeconds: Math.round(t.duration), callDateIso: t.createdAt, timezone: "UTC" },
    flat,
  );

  const r = await chatJson({ provider, baseUrl, apiKey, model, system: buildSystemPrompt(), user: userMessage });
  if (!r.ok) return { code: 200, body: { ok: false, error: r.error, status: r.status } };

  const parsed = parseAndValidate(r.text, {
    transcriptFlat: flat,
    callDateIso: t.createdAt,
    includeCaller: false,
    maxTasks: 8,
    minConfidence: "medium",
  });
  if (!parsed.ok) return { code: 200, body: { ok: false, error: `model output failed validation: ${parsed.error}` } };

  const tasks = parsed.commitments.map((c, i) => buildTaskPayload(c, { callId: t.callId, index: i + 1 }));
  return {
    code: 200,
    body: {
      ok: true,
      model: r.model,
      callSummary: parsed.callSummary,
      tasks,
      dropped: parsed.audit.filter((a) => a.dropped).length,
      auditReasons: parsed.audit.map((a) => a.reason),
    },
  };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BackTalk · Setup</title>
<style>
:root{--bg:#060606;--panel:#0c0c08;--line:#1e1e16;--ink:#f3f3ee;--mut:#9aa1a9;--quo:#d7e62f;--ok:#5fbf7a;--err:#e2885a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:36px 24px 100px}
h1{font-size:28px;font-weight:800;letter-spacing:-.5px;margin:0}
h1 .q{color:var(--quo)}
.sub{color:var(--mut);margin:6px 0 26px}
.step{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin:16px 0}
.step h2{margin:0 0 4px;font-size:17px;display:flex;align-items:center;gap:10px}
.n{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#15150d;border:1px solid #3a3a22;color:var(--quo);font-size:13px;font-weight:800}
.hint{color:var(--mut);font-size:13.5px;margin:4px 0 14px}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:1.2px;color:var(--mut);margin:12px 0 5px}
input,select,textarea{width:100%;background:#0a0a06;border:1px solid var(--line);border-radius:9px;color:var(--ink);padding:9px 12px;font:inherit;font-size:14px}
input:focus,select:focus,textarea:focus{outline:none;border-color:#3a3a22}
button{background:var(--quo);color:#111;border:none;border-radius:9px;padding:9px 18px;font:inherit;font-weight:700;cursor:pointer;margin-top:14px}
button:disabled{opacity:.45;cursor:default}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.out{margin-top:14px;font-size:13.5px;border-radius:9px;padding:10px 14px;display:none;white-space:pre-wrap}
.out.ok{display:block;background:#0a120c;border:1px solid #1c3324;color:var(--ok)}
.out.err{display:block;background:#140d08;border:1px solid #38211a;color:var(--err)}
.task{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0;background:#0a0a06}
.task b{display:block}
.task i{color:var(--mut);font-size:13px}
.warn{background:#141104;border:1px solid #3a3a22;border-radius:12px;padding:12px 16px;font-size:13.5px;color:#d8d8a0;margin-bottom:20px}
code{background:#15150d;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:13px}
textarea{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;min-height:230px}
.row{display:flex;gap:12px}.row>div{flex:1}
</style></head><body><div class="wrap">
<h1><span class="q">QUO</span> BackTalk Setup</h1>
<div class="sub">Four steps: prove your Quo key works, point a webhook here, prove your AI works on a sample call, download your <code>.env</code>.</div>
<div class="warn">SETUP_MODE is on. This wizard is for <b>localhost only</b> — your keys are posted to this local server to run the tests and are never stored. When you're done: put the .env next to server.js, remove <code>SETUP_MODE=1</code>, restart.</div>

<div class="step"><h2><span class="n">1</span> Quo API key</h2>
<div class="hint">From your Quo workspace settings → API. We make one read-only call (<code>GET /phone-numbers</code>) to prove it works and show your lines.</div>
<label>Quo API key</label><input id="quoKey" type="password" autocomplete="off"/>
<button id="quoBtn">Test key</button><div class="out" id="quoOut"></div></div>

<div class="step"><h2><span class="n">2</span> Webhook</h2>
<div class="hint">In the Quo dashboard → Webhooks → create one pointing at <code id="whUrl"></code>, subscribed to <b>call.transcript.completed</b> only. Quo shows a signing key when you create it — paste it here.</div>
<label>Webhook signing secret</label><input id="whSecret" type="password" autocomplete="off" placeholder="base64 key or whsec_..."/></div>

<div class="step"><h2><span class="n">3</span> AI provider</h2>
<div class="hint">Any OpenAI-compatible endpoint (OpenRouter, OpenAI, Groq, local Ollama / LM Studio) or the native Anthropic API. "Test extraction" runs a bundled sample call through the real prompt + validation layer — including a prompt-injection attempt the pipeline should refuse.</div>
<div class="row"><div><label>Provider</label><select id="llmProvider"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic (native)</option></select></div>
<div><label>Base URL (OpenAI-compatible only)</label><input id="llmBase" value="https://openrouter.ai/api/v1"/></div></div>
<div class="row"><div><label>API key</label><input id="llmKey" type="password" autocomplete="off"/></div>
<div><label>Model id</label><input id="llmModel" placeholder="anthropic/claude-haiku-4.5"/></div></div>
<button id="llmBtn">Test extraction</button><div class="out" id="llmOut"></div><div id="llmTasks"></div></div>

<div class="step"><h2><span class="n">4</span> Your .env</h2>
<div class="hint">Built from the values above, entirely in your browser. Save it next to <code>server.js</code>, restart without <code>SETUP_MODE</code>, and you're live.</div>
<button id="genBtn" class="ghost">Generate .env</button>
<button id="dlBtn" style="display:none">Download .env</button>
<textarea id="envText" style="display:none" readonly></textarea></div>

<script>
const $=id=>document.getElementById(id);
$("whUrl").textContent=location.origin.replace(/^http:/,"https:")+"/webhook";
function show(el,ok,msg){el.className="out "+(ok?"ok":"err");el.textContent=msg}
async function post(p,b){const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});return r.json()}
$("quoBtn").onclick=async()=>{
 $("quoBtn").disabled=true;show($("quoOut"),true,"Testing…");
 try{const d=await post("/setup/api/quo",{apiKey:$("quoKey").value});
  if(d.ok){show($("quoOut"),true,"Key works. Lines found:\\n"+d.lines.map(l=>"  • "+l.name+" — "+l.number).join("\\n"))}
  else{show($("quoOut"),false,(d.hint||"")+"\\n"+(d.error||""))}
 }catch(e){show($("quoOut"),false,String(e))}
 $("quoBtn").disabled=false};
$("llmBtn").onclick=async()=>{
 $("llmBtn").disabled=true;show($("llmOut"),true,"Running the sample call through your model…");$("llmTasks").innerHTML="";
 try{const d=await post("/setup/api/llm",{provider:$("llmProvider").value,baseUrl:$("llmBase").value,apiKey:$("llmKey").value,model:$("llmModel").value});
  if(d.ok){show($("llmOut"),true,"Extraction works. Summary: "+d.callSummary+"\\nValidation dropped "+d.dropped+" item(s) — the sample includes an injection attempt that SHOULD be refused.");
   $("llmTasks").innerHTML=d.tasks.map(t=>'<div class="task"><b>'+t.title.replace(/</g,"&lt;")+'</b><i>'+t.description.replace(/</g,"&lt;").replace(/\\n/g,"<br>")+'</i></div>').join("")}
  else{show($("llmOut"),false,d.error||"failed")}
 }catch(e){show($("llmOut"),false,String(e))}
 $("llmBtn").disabled=false};
$("genBtn").onclick=()=>{
 const v=(s)=>s.trim();
 const lines=["# BackTalk .env — generated by the setup wizard","QUO_API_KEY="+v($("quoKey").value),"QUO_WEBHOOK_SECRET="+v($("whSecret").value),"LLM_PROVIDER="+$("llmProvider").value];
 if($("llmProvider").value==="openai")lines.push("LLM_BASE_URL="+v($("llmBase").value));
 lines.push("LLM_API_KEY="+v($("llmKey").value),"LLM_MODEL="+v($("llmModel").value),"","# Recommended starters","TIMEZONE="+(Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"),"IDEMPOTENCY_FILE=.idempotency.json","LEDGER_FILE=.backtalk-ledger.ndjson","#DASHBOARD_TOKEN=pick-a-long-random-string","#DIGEST=1","#ASSIGN_MODE=call-user");
 $("envText").value=lines.join("\\n")+"\\n";$("envText").style.display="block";$("dlBtn").style.display="inline-block"};
$("dlBtn").onclick=()=>{
 const blob=new Blob([$("envText").value],{type:"text/plain"});const a=document.createElement("a");
 a.href=URL.createObjectURL(blob);a.download=".env";a.click();URL.revokeObjectURL(a.href)};
</script></div></body></html>`;

export async function handleSetup(req, res, url, { readBody, send }) {
  if (req.method === "GET" && url.pathname === "/setup") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (req.method === "POST" && (url.pathname === "/setup/api/quo" || url.pathname === "/setup/api/llm")) {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return send(res, 400, { ok: false, error: "invalid json" });
    }
    const out = url.pathname === "/setup/api/quo" ? await testQuo(body) : await testLlm(body);
    return send(res, out.code, out.body);
  }
  return send(res, 404, { ok: false, error: "not found" });
}
