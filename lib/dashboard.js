/**
 * lib/dashboard.js — optional read-only dashboard for BackTalk-created tasks.
 *
 * OFF unless DASHBOARD_TOKEN is set. Routes (GET only):
 *   /dashboard            → HTML page (token required: ?token=... )
 *   /dashboard/api/tasks  → JSON data (token via ?token= or x-dashboard-token)
 *
 * Data sources, in order of preference:
 *   1. Quo API marker scan — every BackTalk task carries
 *      "Source: backtalk ref:<callId>/<n>" in its description, so the
 *      dashboard works retroactively across ALL lines with zero stored state.
 *   2. The local ledger (LEDGER_FILE), when present, adds validation-drop
 *      stats the API can't show, and serves as the only source in DRY_RUN /
 *      keyless setups.
 *
 * Strictly read-only: this module never POSTs anything anywhere.
 */

const MARKER = "Source: backtalk ref:";
const MAX_PAGES = 10;

function parseTask(t) {
  const desc = String(t.description ?? "");
  const ref = desc.match(/Source: backtalk ref:([^\s/]+)\/(\d+)/) || [];
  const quote = (desc.match(/Quote:\s*"([^"]+)"/) || [])[1] || null;
  const spokenDue = (desc.match(/Spoken due:\s*([^\n]+)/) || [])[1]?.trim() || null;
  return {
    taskId: t.taskId ?? t.id ?? null,
    callId: t.activityId || ref[1] || null,
    refIndex: ref[2] ? Number(ref[2]) : null,
    title: t.title || "(untitled)",
    quote: quote === "n/a" ? null : quote,
    spokenDue: spokenDue === "n/a" ? null : spokenDue,
    dueDate: t.dueDate || null,
    completed: Boolean(t.completed),
    createdAt: t.createdAt || null,
    phoneNumberId: t.phoneNumberId || null,
  };
}

async function loadFromQuo({ quo, lineResolver }) {
  const tasks = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await quo.listTasks({ maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    if (!r.ok) break;
    for (const t of r.data?.data ?? []) {
      if (t?.isDeleted) continue;
      if (!String(t?.description ?? "").includes(MARKER)) continue;
      tasks.push(parseTask(t));
    }
    pageToken = r.data?.nextPageToken ?? null;
    if (!pageToken) break;
  }

  const dir = await lineResolver.lines();
  const byCall = new Map();
  for (const t of tasks) {
    const key = t.callId || "unknown";
    if (!byCall.has(key)) byCall.set(key, []);
    byCall.get(key).push(t);
  }

  const groups = [];
  for (const [callId, items] of byCall) {
    items.sort((a, b) => (a.refIndex || 0) - (b.refIndex || 0));
    const ctx = callId !== "unknown" ? await lineResolver.callContext(callId) : null;
    const phoneNumberId = ctx?.phoneNumberId || items[0].phoneNumberId;
    const line = phoneNumberId ? dir.byId.get(phoneNumberId) : null;
    const latest = items.reduce((m, t) => ((t.createdAt ?? "") > m ? t.createdAt : m), "");
    let other = null;
    if (ctx?.participants?.length && line?.number) {
      other = ctx.participants.find((p) => p !== line.number) || ctx.participants[0] || null;
    }
    groups.push({
      callId,
      line: line ? `${line.name} · ${line.number}` : phoneNumberId || "unknown line",
      other,
      callTime: ctx?.createdAt || null,
      direction: ctx?.direction || null,
      filedAt: latest,
      tasks: items,
    });
  }
  groups.sort((a, b) => (b.filedAt || "").localeCompare(a.filedAt || ""));
  return { tasks, groups };
}

/** Ledger-only fallback (DRY_RUN / no API key): visualize what WOULD be filed. */
function loadFromLedger(ledger) {
  const entries = ledger.read({ events: ["task_created", "task_logged"] });
  const byCall = new Map();
  for (const e of entries) {
    const key = e.callId || "unknown";
    if (!byCall.has(key)) byCall.set(key, []);
    byCall.get(key).push({
      taskId: e.taskId ?? null,
      callId: e.callId ?? null,
      refIndex: Number(String(e.ref ?? "").split("/")[1]) || null,
      title: (e.event === "task_logged" ? "[not filed] " : "") + (e.title || "(untitled)"),
      quote: e.quote ?? null,
      spokenDue: e.spokenDue ?? null,
      dueDate: e.dueDate ?? null,
      completed: false,
      createdAt: e.ts ?? null,
      phoneNumberId: e.phoneNumberId ?? null,
    });
  }
  const tasks = [...byCall.values()].flat();
  const groups = [...byCall.entries()].map(([callId, items]) => {
    items.sort((a, b) => (a.refIndex || 0) - (b.refIndex || 0));
    const latest = items.reduce((m, t) => ((t.createdAt ?? "") > m ? t.createdAt : m), "");
    const lineName = entries.find((e) => e.callId === callId && e.lineName)?.lineName;
    return {
      callId,
      line: lineName || items[0].phoneNumberId || "unknown line",
      other: null,
      callTime: null,
      direction: null,
      filedAt: latest,
      tasks: items,
    };
  });
  groups.sort((a, b) => (b.filedAt || "").localeCompare(a.filedAt || ""));
  return { tasks, groups };
}

async function loadData({ quo, ledger, lineResolver }) {
  const { tasks, groups } = quo ? await loadFromQuo({ quo, lineResolver }) : loadFromLedger(ledger);
  const stats = {
    tasks: tasks.length,
    calls: groups.length,
    open: tasks.filter((t) => !t.completed).length,
    done: tasks.filter((t) => t.completed).length,
    lastFiled: groups[0]?.filedAt || null,
    source: quo ? "quo" : "ledger",
  };
  let week = null;
  if (ledger) {
    const s = ledger.stats({ sinceMs: Date.now() - 7 * 86400000 });
    week = { calls: s.calls, created: s.tasksCreated, dropped: s.dropped, dropReasons: s.dropReasons };
  }
  return { stats, week, groups, generatedAt: new Date().toISOString() };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BackTalk · Task Dashboard</title>
<style>
:root{--bg:#060606;--panel:#0c0c08;--line:#1e1e16;--ink:#f3f3ee;--mut:#9aa1a9;--quo:#d7e62f;--amber:#c9a13a;--blue:#74b6e6;--ok:#5fbf7a;--warn:#e2885a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif}
header{padding:22px 28px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:linear-gradient(#060606,#060606e0);backdrop-filter:blur(4px);z-index:5}
h1{margin:0;font-size:24px;font-weight:800;letter-spacing:-.4px}
h1 .q{color:var(--quo)}
.sub{color:var(--mut);font-size:13px;margin-top:3px}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 16px;min-width:96px}
.stat b{display:block;font-size:24px;font-weight:800;letter-spacing:-.5px}
.stat span{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:1.5px}
.wrap{max-width:1040px;margin:0 auto;padding:22px 28px 80px}
.call{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:14px 0}
.call h2{margin:0 0 2px;font-size:15px;font-weight:700;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pill{font-size:10.5px;text-transform:uppercase;letter-spacing:1.2px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
.pill.line{color:var(--quo);border-color:#3a3a22}
.meta{color:var(--mut);font-size:12.5px;margin:2px 0 12px}
.task{border-top:1px solid var(--line);padding:12px 0 10px;display:flex;gap:12px;align-items:flex-start}
.task:first-of-type{border-top:none}
.tnum{color:var(--quo);font-weight:800;font-size:13px;min-width:26px;font-variant-numeric:tabular-nums}
.ttitle{font-weight:600}
.tq{color:var(--mut);font-style:italic;font-size:13px;margin-top:3px;border-left:2px solid #2a2a1e;padding-left:9px}
.tmeta{margin-top:6px;display:flex;gap:8px;flex-wrap:wrap}
.tag{font-size:11px;color:var(--mut);background:#0f0f0a;border:1px solid var(--line);border-radius:6px;padding:1px 7px}
.tag.due{color:var(--amber);border-color:#3a3320}
.tag.open{color:var(--blue)}
.tag.done{color:var(--ok)}
.tag.drop{color:var(--warn)}
.empty{color:var(--mut);text-align:center;padding:60px 0}
.foot{color:#62676e;font-size:12px;text-align:center;margin-top:30px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-right:6px;box-shadow:0 0 0 0 #5fbf7a;animation:p 2s infinite}
@keyframes p{0%{box-shadow:0 0 0 0 #5fbf7a66}70%{box-shadow:0 0 0 7px #5fbf7a00}100%{box-shadow:0 0 0 0 #5fbf7a00}}
</style></head><body>
<header>
  <h1><span class="q">QUO</span> BackTalk · Task Dashboard</h1>
  <div class="sub">Tasks BackTalk filed onto Quo contacts, across every line. Read-only. <span id="upd"></span></div>
  <div class="stats" id="stats"></div>
</header>
<div class="wrap"><div id="list"><div class="empty">Loading…</div></div>
<div class="foot">Read-only · refreshes every 30s · BackTalk dashboard</div></div>
<script>
const TOKEN=new URLSearchParams(location.search).get("token")||sessionStorage.getItem("bt-token")||"";
if(TOKEN){sessionStorage.setItem("bt-token",TOKEN);if(location.search.includes("token=")){history.replaceState(null,"",location.pathname)}}
const esc=s=>(s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function ago(iso){if(!iso)return"";const s=(Date.now()-new Date(iso))/1000;if(s<60)return Math.floor(s)+"s ago";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago"}
function when(iso){if(!iso)return"";return new Date(iso).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}
async function load(){
 let d;
 try{
   const r=await fetch("/dashboard/api/tasks",{headers:{"x-dashboard-token":TOKEN}});
   if(r.status===401){document.getElementById("list").innerHTML='<div class="empty">Unauthorized — open this page as /dashboard?token=&lt;your DASHBOARD_TOKEN&gt;</div>';return}
   d=await r.json();
 }catch(e){return}
 document.getElementById("upd").innerHTML='<span class="dot"></span>updated '+ago(d.generatedAt)+(d.stats.source==="ledger"?" · ledger-only view":"");
 const s=d.stats,w=d.week;
 const cards=[["tasks filed",s.tasks],["calls",s.calls],["open",s.open],["done",s.done]];
 if(w)cards.push(["dropped 7d",w.dropped]);
 document.getElementById("stats").innerHTML=cards
   .map(([l,v])=>'<div class="stat"><b>'+v+'</b><span>'+l+'</span></div>').join("")
   +(s.lastFiled?'<div class="stat"><b style="font-size:15px;font-weight:600;padding-top:7px">'+ago(s.lastFiled)+'</b><span>last filed</span></div>':"");
 const list=document.getElementById("list");
 if(!d.groups.length){list.innerHTML='<div class="empty">No BackTalk tasks yet. When a call wraps, filed tasks appear here.</div>';return}
 list.innerHTML=d.groups.map(g=>{
   const tasks=g.tasks.map(t=>'<div class="task"><div class="tnum">'+(t.refIndex||"•")+'</div><div style="flex:1">'
     +'<div class="ttitle">'+esc(t.title)+'</div>'
     +(t.quote?'<div class="tq">\u201c'+esc(t.quote)+'\u201d</div>':"")
     +'<div class="tmeta">'
       +'<span class="tag '+(t.completed?"done":"open")+'">'+(t.completed?"done":"open")+'</span>'
       +(t.dueDate?'<span class="tag due">due '+when(t.dueDate)+'</span>':(t.spokenDue?'<span class="tag">said: '+esc(t.spokenDue)+'</span>':''))
       +'<span class="tag">filed '+ago(t.createdAt)+'</span>'
     +'</div></div></div>').join("");
   return '<div class="call"><h2><span class="pill line">'+esc(g.line)+'</span>'
     +(g.other?'<span class="pill">'+esc(g.other)+'</span>':'')
     +(g.direction?'<span class="pill">'+esc(g.direction)+'</span>':'')+'</h2>'
     +'<div class="meta">'+(g.callTime?'call '+when(g.callTime)+' · ':'')+'filed '+ago(g.filedAt)+' · '+g.tasks.length+' task'+(g.tasks.length>1?'s':'')+'</div>'
     +tasks+'</div>';
 }).join("");
}
load();setInterval(load,30000);
</script></body></html>`;

/**
 * Route handler mounted by server.js. GET only; token-gated; read-only.
 */
export async function handleDashboard(req, res, url, { token, quo, ledger, lineResolver, send, timingSafeStringEqual }) {
  const presented = url.searchParams.get("token") || req.headers["x-dashboard-token"] || "";
  const authed = presented && timingSafeStringEqual(presented, token);

  if (url.pathname === "/dashboard/api/tasks") {
    if (!authed) return send(res, 401, { ok: false, error: "token" });
    if (!quo && !ledger) return send(res, 503, { ok: false, error: "no data source (set QUO_API_KEY or LEDGER_FILE)" });
    const data = await loadData({ quo, ledger, lineResolver });
    return send(res, 200, data);
  }

  if (url.pathname === "/dashboard") {
    if (!authed) return send(res, 401, { ok: false, error: "open /dashboard?token=<your DASHBOARD_TOKEN>" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  return send(res, 404, { ok: false, error: "not found" });
}
