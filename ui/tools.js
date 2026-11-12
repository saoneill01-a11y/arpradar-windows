// The Tools menu: each tool runs in its own window (tool.html), told which tool by window.__TOOL__.
"use strict";

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function load(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch {} }
const advanced = () => load("mode", "basic") === "advanced";
const fmt = (v, digits = 0) => v == null || Number.isNaN(v) ? "–" : v.toFixed(digits);
const isIPv4 = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s.trim()) && s.trim().split(".").every(o => Number(o) <= 255);
const COLORS = ["#2fd17a", "#4aa3ff", "#ffb347", "#c58bff", "#ff7aa8", "#5ce1e6"];

// Appearance comes from look.js (shared with the main window).
/// Tells the main window a tool is busy, so its radar sweeps (as on the Mac).
const busy = (key, on) => { try { T.event.emit?.("activity", { key: `${window.__TOOL__?.tool || "tool"}-${key}`, on })?.catch(() => {}); } catch {} };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
}

/// A line chart on a canvas. series: [{color, points: [{t, v}]}] (v null = a gap, drawn as a red tick when `lossTicks`).
function drawChart(canvas, series, opts) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const L = 44, R = 10, Tp = 10, B = 22;
  const vals = series.flatMap(s => s.points.map(p => p.v)).filter(v => v != null);
  let yMin = opts.yMin ?? 0, yMax = opts.yMax ?? Math.max(10, ...vals) * 1.15;
  if (opts.fitY && vals.length) { yMin = Math.min(...vals) - 5; yMax = Math.max(...vals) + 5; }
  const x = t => L + (t - opts.tMin) / (opts.tMax - opts.tMin) * (w - L - R);
  const y = v => Tp + (1 - (v - yMin) / (yMax - yMin)) * (h - Tp - B);
  if (opts.band) { // e.g. the "good" signal zone
    g.fillStyle = "rgba(47,209,122,0.10)";
    const top = y(Math.min(yMax, opts.band[1])), bottom = y(Math.max(yMin, opts.band[0]));
    g.fillRect(L, top, w - L - R, bottom - top);
  }
  g.strokeStyle = css("--line"); g.fillStyle = css("--muted"); g.font = "11px Segoe UI, system-ui, sans-serif"; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (yMax - yMin) * i / 4, yy = y(v);
    g.beginPath(); g.moveTo(L, yy); g.lineTo(w - R, yy); g.stroke();
    g.fillText(fmt(v), 4, yy + 4);
  }
  if (opts.yLabel) { g.textAlign = "right"; g.fillText(opts.yLabel, w - R, h - 6); g.textAlign = "left"; }
  if (opts.xLabel) { g.textAlign = "right"; g.fillText(opts.xLabel, w - R, h - 6); g.textAlign = "left"; }
  for (const m of opts.markers || []) { g.strokeStyle = "#f5a623"; g.beginPath(); g.moveTo(x(m), Tp); g.lineTo(x(m), h - B); g.stroke(); }
  for (const s of series) {
    g.strokeStyle = s.color; g.lineWidth = 2; g.beginPath();
    let open = false;
    for (const p of s.points) {
      if (p.v == null) {
        open = false;
        if (opts.lossTicks) { g.save(); g.strokeStyle = css("--red"); g.lineWidth = 1; g.beginPath(); g.moveTo(x(p.t), Tp); g.lineTo(x(p.t), h - B); g.stroke(); g.restore(); }
        continue;
      }
      const v = Math.max(yMin, Math.min(yMax, p.v));
      open ? g.lineTo(x(p.t), y(v)) : g.moveTo(x(p.t), y(v));
      open = true;
    }
    g.stroke();
  }
}

/// How long the Ping tool waits for each reply, separate from the send interval (same as the Mac).
const PING_REPLY_TIMEOUT_MS = 2000;

/// Download a table as CSV or Excel through the main app's export commands.
async function download(kind, base, header, rows, sheet) {
  const name = base.replace(/[\\/:*?"<>|]/g, "-");
  if (kind === "csv") {
    return invoke("export_csv", { fileName: name + ".csv", content: csvText(header, rows) });
  }
  return invoke("export_xlsx", { fileName: name + ".xlsx", sheet: sheet || "Results", header, rows: rows.map(r => r.map(String)) });
}

// MARK: Ping

function pingTool(root, arg) {
  document.title = "Ping";
  root.innerHTML = `<div class="bar">
      <div class="field grow"><label for="pt">Targets (names or IPs, separated by commas)</label><input id="pt" placeholder="192.168.1.1, 8.8.8.8, example.com" spellcheck="false"></div>
      <div class="field"><label for="pe">Every</label><select id="pe"><option value="0.5">0.5 s</option><option value="1" selected>1 s</option><option value="2">2 s</option><option value="5">5 s</option></select></div>
      <button type="button" id="pgo" class="primary">Start</button></div>
    <p class="problem" id="pprob" hidden></p>
    <div class="tablebox" style="flex:none"><table class="tt"><thead><tr><th>Target</th><th>Address</th><th class="num">Last</th><th class="num">Average</th><th class="num">Min</th><th class="num">Max</th><th class="num">Jitter</th><th class="num">Lost</th></tr></thead><tbody id="prows"></tbody></table></div>
    <canvas class="chart" id="pc"></canvas>
    <div class="bar"><p class="note grow">Last 60 seconds, in milliseconds. Red lines are replies that didn’t come back.</p><span id="psave"></span></div>`;
  $("pt").value = arg || load("pingTargets", "");
  let timer = null, targets = [], samples = [];
  const stats = list => {
    const got = list.filter(v => v != null);
    const s = { sent: list.length, lost: list.length - got.length, last: list.at(-1) };
    if (got.length) {
      s.avg = got.reduce((a, b) => a + b, 0) / got.length; s.min = Math.min(...got); s.max = Math.max(...got);
      if (got.length > 1) s.jitter = got.slice(1).reduce((a, v, i) => a + Math.abs(v - got[i]), 0) / (got.length - 1);
    }
    return s;
  };
  const draw = () => {
    const now = Date.now(), cut = now - 60000;
    $("prows").innerHTML = targets.map((t, i) => {
      const s = stats(samples.filter(x => x.target === t.name && x.time >= cut).map(x => x.ms));
      return `<tr><td><span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>${esc(t.name)}</td><td class="mono">${esc(t.ip || "not found")}</td>
        <td class="num">${s.last === undefined ? "–" : s.last == null ? '<span class="poor">lost</span>' : fmt(s.last, 1)}</td><td class="num">${fmt(s.avg, 1)}</td><td class="num">${fmt(s.min, 1)}</td><td class="num">${fmt(s.max, 1)}</td><td class="num">${fmt(s.jitter, 1)}</td>
        <td class="num">${s.sent ? Math.round(s.lost / s.sent * 100) + "%" : "–"}</td></tr>`;
    }).join("");
    drawChart($("pc"), targets.filter(t => t.ip).map((t, i) => ({ color: COLORS[targets.indexOf(t) % COLORS.length], points: samples.filter(x => x.target === t.name && x.time >= cut).map(x => ({ t: x.time, v: x.ms })) })),
      { tMin: cut, tMax: now, lossTicks: true, yLabel: "ms" });
  };
  let run = 0;   // each Start is a new run; rounds of an older run are dropped
  const stop = () => { run++; clearTimeout(timer); timer = null; $("pgo").textContent = "Start"; $("pgo").className = "primary"; busy("ping", false); };
  const start = async () => {
    const names = $("pt").value.split(/[\s,]+/).filter(Boolean);
    if (!names.length) return;
    save("pingTargets", $("pt").value);
    const ips = await invoke("resolve_names", { names });
    targets = names.map((name, i) => ({ name, ip: ips[i] }));
    const missing = targets.filter(t => !t.ip).map(t => t.name);
    $("pprob").hidden = !missing.length; $("pprob").textContent = `Couldn’t find ${missing.join(", ")}.`;
    if (!targets.some(t => t.ip)) return;
    samples = [];
    $("pgo").textContent = "Stop"; $("pgo").className = "stop"; busy("ping", true);
    const every = Number($("pe").value) * 1000;
    const me = ++run;
    const round = async () => {
      const started = Date.now();
      const live = targets.filter(t => t.ip);
      // A reply counts if it comes within 2 s, whatever the interval (a slow reply isn't a lost one).
      const r = await invoke("ping_round", { ips: live.map(t => t.ip), timeoutMs: PING_REPLY_TIMEOUT_MS });
      if (me !== run || timer === null) return;
      for (const t of live) samples.push({ target: t.name, time: started, ms: r[t.ip] ?? null });
      if (samples.length > 600 * live.length) samples.splice(0, samples.length - 600 * live.length);
      draw();
      timer = setTimeout(round, Math.max(0, every - (Date.now() - started)));
    };
    timer = setTimeout(round, 0);
  };
  $("pgo").onclick = () => timer ? stop() : start();
  $("pt").onkeydown = e => { if (e.key === "Enter") { stop(); start(); } };
  window.addEventListener("resize", draw);
  saveToOrgButton($("psave"), () => { const cut = Date.now() - 60000;
    return Drafts.ping(targets.filter(t => t.ip).map(t => ({ target: t.name, ...stats(samples.filter(x => x.target === t.name && x.time >= cut).map(x => x.ms)) }))); }, { auto: false });
  draw();
  if (arg) start();
  return a => { stop(); $("pt").value = a; start(); };
}

// MARK: Traceroute

function traceTool(root, arg) {
  document.title = "Traceroute";
  root.innerHTML = `<div class="bar">
      <div class="field grow"><label for="tt">Name or IP</label><input id="tt" placeholder="example.com or 8.8.8.8" spellcheck="false"></div>
      <button type="button" id="tgo" class="primary">Trace</button><button type="button" id="tcopy" disabled>Copy</button><span id="tsave"></span></div>
    <div class="status" id="tst"></div>
    <div class="tablebox"><table class="tt"><thead><tr><th class="num">#</th><th>Address</th><th>Name</th><th class="num">Time</th></tr></thead><tbody id="trows"></tbody></table></div>
    <p class="note">Each router on the way is asked once. A * means that router didn’t answer (many are set up not to).</p>`;
  $("tt").value = arg || "";
  let hops = [], running = false, run = 0;   // events from an older run (stopped or replaced) are dropped
  const draw = () => {
    $("trows").innerHTML = hops.map(h => `<tr><td class="num">${h.number}</td><td class="mono">${esc(h.address)}</td><td>${esc(h.name)}</td><td class="num">${h.ms == null ? "" : fmt(h.ms, 0) + " ms"}</td></tr>`).join("");
    $("tcopy").disabled = !hops.length;
  };
  const setRunning = on => { running = on; busy("trace", on); $("tgo").textContent = on ? "Stop" : "Trace"; $("tgo").className = on ? "stop" : "primary"; };
  T.event.listen("trace", e => {
    const ev = e.payload;
    if (ev.run !== run || !running) return;
    if (ev.kind === "resolved") $("tst").textContent = `Tracing ${$("tt").value.trim()} (${ev.address})…`;
    if (ev.kind === "hop") { hops.push(ev.hop); draw(); }
    if (ev.kind === "failed") { setRunning(false); $("tst").textContent = ev.message; }
    if (ev.kind === "done") { setRunning(false); $("tst").textContent = ev.cancelled ? "Stopped" : `${ev.hops} hops`; }
  });
  const start = () => {
    const t = $("tt").value.trim(); if (!t) return;
    hops = []; draw(); setRunning(true); $("tst").textContent = `Tracing ${t}…`;
    const me = ++run;
    invoke("trace_start", { target: t, run: me }).catch(e => { if (me === run) { setRunning(false); $("tst").textContent = String(e); } });
  };
  $("tgo").onclick = () => running ? (run++, invoke("job_stop", { key: "trace" }), setRunning(false), $("tst").textContent = "Stopped") : start();
  $("tt").onkeydown = e => { if (e.key === "Enter" && !running) start(); };
  const refreshT = saveToOrgButton($("tsave"), () => Drafts.traceroute($("tt").value.trim(), hops), { enabled: () => hops.length > 0 && !running });
  setInterval(refreshT, 1000);
  $("tcopy").onclick = () => copyText(hops.map(h => `${h.number}\t${h.address}\t${h.name}\t${h.ms == null ? "" : Math.round(h.ms) + " ms"}`).join("\n"));
  if (arg) start();
  return a => { $("tt").value = a; if (running) { invoke("job_stop", { key: "trace" }); setRunning(false); } start(); };
}

// MARK: DNS Lookup

// MARK: DNS Look Up grouped by record type (the Mac's DNSSectionsView)

const DNS_GROUP_ORDER = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "CAA", "SOA", "PTR", "DS", "DNSKEY"];
const DNS_GROUP_DESC = { A: "IPv4 addresses", AAAA: "IPv6 addresses", CNAME: "aliases", MX: "mail servers", NS: "name servers",
  TXT: "text (SPF, verification)", SRV: "services", CAA: "who may issue certificates", SOA: "zone settings", PTR: "names for an address",
  DS: "DNSSEC keys", DNSKEY: "DNSSEC keys" };
/// lines: [{name, depth, ttl, type, data}] in answer order. A record reached through a CNAME (depth > 0) stays with the
/// record above it. Returns [{type, heading, lines}] in DNS_GROUP_ORDER (then any others), sorted by name in a group.
function dnsSections(lines) {
  const blocks = [];
  for (const l of lines) { if (l.depth > 0 && blocks.length) blocks.at(-1).push(l); else blocks.push([l]); }
  const byType = new Map();
  for (const b of blocks) { const t = b[0].type; if (!byType.has(t)) byType.set(t, []); byType.get(t).push(b); }
  const types = [...DNS_GROUP_ORDER.filter(t => byType.has(t)), ...[...byType.keys()].filter(t => !DNS_GROUP_ORDER.includes(t)).sort()];
  return types.map(t => {
    const list = byType.get(t).map((b, i) => [b, i]).sort((x, y) => {
      const a = x[0][0].name.toLowerCase(), b = y[0][0].name.toLowerCase();
      return a === b ? x[1] - y[1] : a < b ? -1 : 1;
    }).map(x => x[0]);
    return { type: t, heading: `${t} · ${list.length}${DNS_GROUP_DESC[t] ? ` · ${DNS_GROUP_DESC[t]}` : ""}`, lines: list.flat() };
  });
}
/// A saved DNS lookup's rows (Name, Type, TTL, Answer; "  ↳ name" for a followed CNAME) as lines for dnsSections.
function dnsLinesFromRows(rows) {
  return rows.filter(r => r.length >= 4).map(r => {
    const lead = (/^ */.exec(r[0]) || [""])[0].length, chained = isChainRow(r);
    return { name: chained ? r[0].slice(lead + 2) : r[0], depth: chained ? Math.floor(lead / 2) + 1 : 0, ttl: r[2], type: r[1], data: r[3] };
  });
}
/// One outlined box per type with a darker heading bar that folds the group when clicked.
function dnsSectionsHtml(sections, folded) {
  return sections.map(g => `<section class="dnsgroup${folded.has(g.type) ? " folded" : ""}">
    <button type="button" class="dnshead" data-fold="${esc(g.type)}" aria-expanded="${!folded.has(g.type)}"><span class="chev">${folded.has(g.type) ? "▸" : "▾"}</span>${esc(g.heading)}</button>
    ${folded.has(g.type) ? "" : `<table class="tt dnsg"><colgroup><col style="width:38%"><col style="width:70px"><col></colgroup><tbody>${g.lines.map(l => `<tr class="${l.depth ? "child" : ""}" data-answer="${esc(`${l.name}\t${l.type}\t${l.ttl}\t${l.data}`)}">
      <td style="${l.depth ? `padding-left:${8 + l.depth * 16}px` : ""}" title="${esc(l.name)}">${l.depth ? "↳ " : ""}${esc(l.name)}</td><td class="num ttl" title="Time to live: ${esc(l.ttl)} seconds">${esc(l.ttl)}</td>
      <td class="mono" title="${esc(`${l.type} ${l.data}\nDouble-click to copy`)}">${l.depth ? `<span class="typetag">${esc(l.type)}</span>` : ""}${esc(l.data)}</td></tr>`).join("")}</tbody></table>`}</section>`).join("");
}
/// Wires folding: clicking a heading folds its group (redraw() draws again).
function dnsFoldClicks(el, folded, redraw, onCopied) {
  el.addEventListener("click", e => { const b = e.target.closest("[data-fold]"); if (!b) return; const t = b.dataset.fold; folded.has(t) ? folded.delete(t) : folded.add(t); redraw(); });
  // Double-click an answer to copy it (name, type, TTL, data).
  el.addEventListener("dblclick", e => { const r = e.target.closest("[data-answer]"); if (!r) return; copyText(r.dataset.answer); onCopied?.(r.dataset.answer.split("\t").pop()); });
}

const DNS_TYPES = ["All", "A", "AAAA", "PTR", "MX", "TXT", "SRV", "CNAME", "NS", "SOA", "CAA", "DS", "DNSKEY"];
const DNS_SERVICES = ["_ldap._tcp", "_kerberos._tcp", "_kerberos._udp", "_kpasswd._tcp", "_gc._tcp", "_ldap._tcp.dc._msdcs", "_autodiscover._tcp",
  "_sip._tls", "_sipfederationtls._tcp", "_xmpp-client._tcp", "_caldavs._tcp", "_carddavs._tcp", "_imaps._tcp", "_submission._tcp"];
const DNS_HOSTS = DNS_COMMON_HOSTS;
const DNS_TXT = ["_dmarc", "_mta-sts", "_smtp._tls", "default._bimi", "selector1._domainkey", "selector2._domainkey", "google._domainkey",
  "k1._domainkey", "default._domainkey", "s1._domainkey", "s2._domainkey"];
function allQueries(name) {
  const n = name.trim().replace(/^\.+|\.+$/g, "");
  return [...["A", "AAAA", "CNAME", "MX", "NS", "SOA", "TXT", "CAA"].map(t => [n, t]), ...DNS_TXT.map(x => [`${x}.${n}`, "TXT"]),
    ...DNS_HOSTS.map(x => [`${x}.${n}`, "A"]), ...DNS_SERVICES.map(x => [`${x}.${n}`, "SRV"])];
}
const normName = s => s.toLowerCase().replace(/^\.+|\.+$/g, "");
/// The asked name's own records (depth 0); with `follow`, also records of the names its CNAMEs point to, indented.
function arrange(answers, asked, follow) {
  const depth = new Map([[normName(asked), 0]]);
  const out = [];
  for (const a of answers) {
    const d = depth.get(normName(a.name));
    if (d === undefined) continue;
    if (d === 0 || follow) out.push({ ...a, depth: d });
    if (a.type === "CNAME" && !depth.has(normName(a.data))) depth.set(normName(a.data), d + 1);
  }
  return out;
}
/// The host from whatever was typed or pasted: drops https://, a path, a port and a trailing dot.
function cleanHost(text) {
  let s = text.trim().toLowerCase();
  const i = s.indexOf("://"); if (i >= 0) s = s.slice(i + 3);
  s = s.split(/[/?#]/)[0];
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  if ((s.match(/:/g) || []).length === 1) s = s.split(":")[0];
  return s.replace(/\.+$/, "");
}
const isAddress = s => isIPv4(s) || s.includes(":");
const reverseName = ip => ip.trim().split(".").reverse().join(".") + ".in-addr.arpa";

async function dnsTool(root, arg) {
  document.title = "DNS Lookup";
  let servers = [];
  try { const d = JSON.parse(await invoke("load_data") || "{}"); servers = (d.sites || []).filter(s => s.nameServer).map(s => [s.name, s.nameServer]); } catch {}
  const serverList = id => `<datalist id="${id}">${servers.map(([n, ip]) => `<option value="${esc(ip)}">${esc(n)}</option>`).join("")}</datalist>`;
  const TABS = [["lookup", "Look Up"], ["email", "Email Check"], ["compare", "Compare Servers"], ["expiry", "Expiry"], ["reverse", "Reverse Subnet"]];
  let tab = load("dnsTab", "lookup");
  root.innerHTML = `<div class="bar">
      <div class="field grow"><label for="dq">Domain or web address (or an IP address for its name)</label><input id="dq" class="mono" placeholder="example.com" spellcheck="false"></div>
      <div class="field"><label for="ds">Server</label><input id="ds" list="dsl" placeholder="this PC’s DNS" spellcheck="false" style="width:170px">${serverList("dsl")}</div>
      <button type="button" id="dall" class="primary" title="Runs Look Up, Email Check, Compare Servers and Expiry for this domain">Check all</button></div>
    <div class="segmented" id="dtabs" style="align-self:flex-start">${TABS.map(([k, t]) => `<button type="button" data-tab="${k}">${t}<span class="mark" id="m-${k}"></span></button>`).join("")}</div>
    <section id="p-lookup" class="dnspanel">
    <div class="bar">
      <div class="field"><label for="dt">Type</label><select id="dt">${DNS_TYPES.map(t => `<option>${t}</option>`).join("")}</select></div>
      <span class="grow"></span><button type="button" id="dgo">Look up again</button></div>
    <div class="bar"><label class="check"><input type="checkbox" id="df"> Follow CNAMEs to other domains</label>
      <label class="check" title="Asks crt.sh (or Cert Spotter) for every name this domain has had an HTTPS certificate for, then looks each one up"><input type="checkbox" id="dsub"> Find subdomains (certificate logs)</label><span class="grow"></span>
      <span id="dsave"></span><button type="button" id="dcopy" disabled title="Copy every answer, ready to paste into Excel">Copy</button><button type="button" id="dcsv" disabled>Download CSV…</button><button type="button" id="dxls" disabled>Download Excel (.xlsx)…</button></div>
    <div class="status" id="dst"></div>
    <div class="tablebox dnsbox" id="drows"></div>
    <p class="note">“All” asks about ${8 + DNS_TXT.length + DNS_COMMON_HOSTS.length + DNS_SERVICES.length} things at once: the usual records, email security (DMARC, DKIM, MTA-STS), about ${DNS_COMMON_HOSTS.length} common host names and Active Directory / Microsoft 365 service records. Find subdomains adds every name from the public certificate logs.</p>
    </section>
    <section id="p-email" class="dnspanel" hidden>
      <div class="bar"><span class="note grow" id="elabel">Mail servers, SPF, DMARC, DKIM, MTA-STS, BIMI and DNSSEC for the domain above.</span>
        <span id="esave"></span><button type="button" id="ego">Check again</button></div>
      <div class="bar" id="echips"></div><div class="status" id="est"></div>
      <div class="tablebox"><table class="tt"><tbody id="erows"></tbody></table></div>
    </section>
    <section id="p-compare" class="dnspanel" hidden>
      <div class="bar"><span class="note grow" id="clabel">Asks several DNS servers the same question and shows any that disagree.</span>
        <div class="field"><label for="ct">Type</label><select id="ct">${DNS_TYPES.filter(t => t !== "All").map(t => `<option>${t}</option>`).join("")}</select></div>
        <span id="csave2"></span><button type="button" id="cgo">Compare again</button></div>
      <div class="bar" id="cservers"></div>
      <div id="cbanner"></div><div class="status" id="cst"></div>
      <div class="tablebox"><table class="tt"><thead><tr><th>Server</th><th>Answer</th><th class="num">TTL</th><th class="num">Time</th></tr></thead><tbody id="crows"></tbody></table></div>
      <p class="note" id="csoa"></p>
    </section>
    <section id="p-expiry" class="dnspanel" hidden>
      <div class="bar"><span class="note grow" id="xlabel">When the domain’s registration and its HTTPS certificates run out.</span>
        <span id="xsave"></span><button type="button" id="xgo">Check again</button></div>
      <div class="big" id="xtiles"></div><div class="status" id="xst"></div>
      <div class="tablebox"><table class="tt"><thead><tr><th>HTTPS certificate on</th><th>Expires</th><th>Issued by</th><th>Covers</th></tr></thead><tbody id="xrows"></tbody></table></div>
      <p class="note">Asks rdap.org for the registration dates. Certificates are read from each host on port 443 (remote and vpn also 4443/8443). Orange under 30 days, red when expired.</p>
    </section>
    <section id="p-reverse" class="dnspanel" hidden>
      <div class="bar"><div class="field grow"><label for="rn2">Range</label><input id="rn2" class="mono" placeholder="10.0.0.0/24" spellcheck="false"></div>
        <div class="field"><label for="rs2">Server</label><input id="rs2" list="rsl" placeholder="this PC’s DNS" spellcheck="false" style="width:170px">${serverList("rsl")}</div>
        <button type="button" id="rgo" class="primary">Look Up</button><span id="rsave"></span></div>
      <div class="bar"><label class="check"><input type="checkbox" id="rall"> Show addresses with no name too</label><span class="grow"></span><button type="button" id="rcsv" disabled>Download CSV…</button></div>
      <div class="status" id="rst"></div>
      <div class="tablebox"><table class="tt"><thead><tr><th>IP</th><th>Name</th></tr></thead><tbody id="rrows"></tbody></table></div>
    </section>`;
  const showTab = t => { tab = t; save("dnsTab", t); $("dtabs").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tab === t)); TABS.forEach(([k]) => ($(`p-${k}`).hidden = k !== t)); };
  $("dtabs").onclick = e => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); };
  // Several tabs can run at once (Check all): busy until the last one finishes.
  let active = 0;
  const busyDns = on => { active = Math.max(0, active + (on ? 1 : -1)); busy("dns", active > 0); allButton(); };
  // Each tab's run number: results from a run that was stopped or replaced by a newer one are dropped.
  const runs = { lookup: 0, email: 0, compare: 0, expiry: 0, reverse: 0 };
  const guarded = (key, fn) => async () => {
    const my = ++runs[key];
    busyDns(true);
    try { await fn(() => my === runs[key]); } finally { busyDns(false); }
  };
  const allButton = () => { const b = $("dall"); if (!b) return; const on = active > 0; b.textContent = on ? "Stop" : "Check all"; b.className = on ? "stop" : "primary"; };
  // The one domain box: every domain tab reads it. host() as typed (cleaned), base() without a leading www.
  const host = () => cleanHost($("dq").value), base = () => host().replace(/^www\./, "");
  const dnsServer = () => $("ds").value.trim();
  const MARK = { running: "…", done: "✓", warn: "⚠" };
  const mark = (k, state) => { const m = $(`m-${k}`); m.className = `mark ${state || ""}`; m.textContent = MARK[state] || ""; };

  // --- Look Up
  $("dq").value = arg || "";
  $("df").checked = load("dnsFollowCNAMEs", "0") === "1";
  $("dsub").checked = load("dnsFindSubdomains", "0") === "1";
  const folded = new Set();
  let groups = [], lookBusy = false, lastAsked = { name: "", type: "", server: "" };
  const rows = () => groups.flatMap(g => arrange(g.answers, g.asked, $("df").checked));
  const draw = () => {
    const list = rows();
    $("drows").innerHTML = dnsSectionsHtml(dnsSections(list.map(a => ({ ...a, ttl: String(a.ttl) }))), folded);
    $("dcsv").disabled = $("dxls").disabled = $("dcopy").disabled = !list.length;
  };
  const lookUp = guarded("lookup", async live => {
    const type = $("dt").value, name = type === "All" ? base() : host(), server = dnsServer();
    if (!name) return;
    mark("lookup", "running");
    lastAsked = { name, type, server };
    lookBusy = true;
    groups = []; draw();
    let qs = type === "All" ? (isIPv4(name) ? [[name, "PTR"]] : allQueries(name)) : [[name, type]];
    let subNote = "";
    if (type === "All" && !isIPv4(name) && $("dsub").checked) {
      $("dst").textContent = "Asking the certificate logs for subdomains… (can take 30 seconds)";
      try {
        const [found, src] = await invoke("find_subdomains", { domain: name });
        const asked = new Set(qs.map(q => q[0].toLowerCase()));
        const extra = found.filter(n => !asked.has(n)).slice(0, 300);
        qs = qs.concat(extra.map(n => [n, "A"]));
        subNote = ` · ${extra.length} more names from ${src}`;
      } catch (e) { subNote = ` · subdomains: ${e}`; }
      if (!live()) return;
    }
    $("dst").textContent = `Asking ${qs.length > 1 ? qs.length + " questions" : "…"}`;
    const results = new Array(qs.length);
    let next = 0, failed = "", ms = 0, used = "";
    const worker = async () => {
      while (next < qs.length && live()) {
        const i = next++;
        const [n, t] = qs[i];
        try {
          const r = await invoke("dns_lookup", { name: n, kind: t, server });
          used = r.server; ms = Math.max(ms, r.ms);
          results[i] = { asked: isIPv4(n) && (t === "PTR" || t === "A") ? reverseName(n) : n, answers: r.answers, status: r.status };
        } catch (e) { failed = String(e); results[i] = { asked: n, answers: [] }; }
        if (live()) { groups = results.filter(Boolean); draw(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, qs.length) }, worker));
    if (!live()) return;
    lookBusy = false;
    const n = rows().length;
    mark("lookup", n ? "done" : "warn");
    const nx = qs.length === 1 && results[0]?.status ? ` (${results[0].status})` : "";
    $("dst").textContent = failed && !n ? failed : `${n} record${n === 1 ? "" : "s"}${nx} · ${ms} ms · ${used || "this PC’s DNS"}${subNote}`;
  });
  $("dgo").onclick = lookUp;
  dnsFoldClicks($("drows"), folded, () => draw(), what => ($("dst").textContent = `Copied ${what}`));
  $("dcopy").onclick = () => { const list = rows(); copyText(list.map(a => [(a.depth ? "↳ " : "") + a.name, a.type, a.ttl, a.data].join("\t")).join("\n")); $("dst").textContent = `Copied ${list.length} answer${list.length === 1 ? "" : "s"}`; };
  for (const id of ["dq", "ds"]) $(id).onkeydown = e => { if (e.key === "Enter") checkAll(); };
  $("df").onchange = () => { save("dnsFollowCNAMEs", $("df").checked ? "1" : "0"); draw(); };
  $("dsub").onchange = () => save("dnsFindSubdomains", $("dsub").checked ? "1" : "0");
  const exp = kind => download(kind, `DNS ${lastAsked.name}`, ["Name", "Type", "TTL", "Data"],
    rows().map(a => [(a.depth ? "↳ " : "") + a.name, a.type, a.ttl, a.data]), "DNS").catch(e => ($("dst").textContent = String(e)));
  const refreshD = saveToOrgButton($("dsave"), () => Drafts.dns(lastAsked.name, lastAsked.type, lastAsked.server, groups.flatMap(g => arrange(g.answers, g.asked, true))),
    { enabled: () => !lookBusy && groups.some(g => g.answers.length) });
  $("dcsv").onclick = () => exp("csv"); $("dxls").onclick = () => exp("xlsx");

  const refreshers = [];
  // --- Email Check
  let emailRows = [], emailDomain = "";
  const ICON = { good: ["✓", "good"], warn: ["!", "fair"], bad: ["✗", "poor"], info: ["–", ""] };
  const runEmail = guarded("email", async live => {
    const d = base(); if (!d || isAddress(d)) return;
    emailDomain = d; $("elabel").textContent = `Email for ${d}`; $("est").textContent = "Checking…"; $("erows").innerHTML = ""; $("echips").innerHTML = ""; mark("email", "running");
    emailRows = [];
    let found;
    try { found = await emailCheck(d, dnsServer()); } catch (e) { if (live()) { $("est").textContent = String(e); mark("email", "warn"); } return; }
    if (!live()) return;
    emailRows = found;
    mark("email", emailRows.some(r => r.state === "warn" || r.state === "bad") ? "warn" : "done");
    const count = k => emailRows.filter(r => r.state === k).length;
    $("echips").innerHTML = [["good", "good", "chipgood"], ["warn", "to look at", "chipwarn"], ["bad", count("bad") === 1 ? "problem" : "problems", "chipbad"]]
      .filter(([k]) => count(k)).map(([k, t, c]) => `<span class="chip ${c}">${count(k)} ${t}</span>`).join("");
    $("est").textContent = "";
    $("erows").innerHTML = emailRows.map(r => `<tr><td style="width:24px" class="${ICON[r.state][1]}">${ICON[r.state][0]}</td><td style="width:110px"><b>${esc(r.check)}</b></td>
      <td><span class="${/=/.test(r.text) ? "mono" : ""}" style="word-break:break-word">${esc(r.text)}</span>${r.detail ? `<br><span class="note" style="white-space:pre-line">${esc(r.detail)}</span>` : ""}</td></tr>`).join("");
  });
  $("ego").onclick = runEmail;
  refreshers.push(saveToOrgButton($("esave"), () => emailRows.length ? { kind: "dns", title: `Email check · ${emailDomain}`,
    summary: ["good", "warn", "bad"].map(k => `${emailRows.filter(r => r.state === k).length} ${k === "good" ? "good" : k === "warn" ? "to look at" : "problems"}`).join(", "),
    table: { header: ["", "Check", "Result", "Details"], rows: emailRows.map(r => [ICON[r.state][0], r.check, r.text, r.detail]), widths: [4, 12, 60, 70] } } : null,
    { enabled: () => emailRows.length > 0 }));

  // --- Compare Servers
  const defaultServer = await invoke("dns_default_server").catch(() => null);
  const fixed = [{ key: "pc", label: `This PC’s DNS${defaultServer ? ` (${defaultServer})` : ""}`, server: "" },
    ...servers.map(([n, ip]) => ({ key: `site-${ip}`, label: `${n} name server (${ip})`, server: ip })),
    { key: "cf", label: "Cloudflare 1.1.1.1", server: "1.1.1.1" }, { key: "google", label: "Google 8.8.8.8", server: "8.8.8.8" },
    { key: "quad9", label: "Quad9 9.9.9.9", server: "9.9.9.9" }, { key: "own", label: "The domain’s own name servers", server: null }];
  let off = new Set(); try { off = new Set(JSON.parse(load("compareOff", "[]"))); } catch {}
  $("cservers").innerHTML = fixed.map(f => `<label class="check"><input type="checkbox" data-k="${esc(f.key)}" ${off.has(f.key) ? "" : "checked"}> ${esc(f.label)}</label>`).join("");
  $("cservers").onchange = e => { const k = e.target.dataset.k; e.target.checked ? off.delete(k) : off.add(k); save("compareOff", JSON.stringify([...off])); };
  let cmp = null, cmpAsked = "";
  const runCompare = guarded("compare", async live => {
    const name = host(), type = $("ct").value; if (!name || isAddress(name)) return;
    cmpAsked = `${name} (${type})`; $("clabel").textContent = `Compared ${cmpAsked}`; mark("compare", "running"); $("cst").textContent = "Asking…"; $("crows").innerHTML = ""; $("cbanner").innerHTML = ""; $("csoa").textContent = ""; cmp = null;
    const list = fixed.filter(f => !off.has(f.key) && f.server !== null).map(f => ({ label: f.label, server: f.server }));
    let zoneInfo = null;
    if (!off.has("own")) {
      zoneInfo = await ownNameServers(name, "");
      if (!live()) return;
      for (const ns of zoneInfo.ns) list.unshift({ label: `${ns} (own)`, server: ns });
    }
    const res = await compareServers(name, type, list);
    if (!live()) return;
    cmp = res;
    $("cst").textContent = "";
    $("crows").innerHTML = cmp.rows.map(r => `<tr style="${r.different ? "background:color-mix(in srgb, #f5b942 14%, transparent)" : ""}"><td>${esc(r.label)}</td>
      <td class="mono" style="white-space:pre-line;${r.different ? "color:#f5b942" : ""}">${esc(r.answer)}${r.different ? " (different)" : ""}</td><td class="num">${r.ttl ?? ""}</td><td class="num">${r.ms != null ? r.ms + " ms" : ""}</td></tr>`).join("");
    if (cmp.differ) {
      const odd = cmp.rows.filter(r => r.different);
      const ttl = odd.map(r => r.ttl).filter(t => t != null);
      $("cbanner").innerHTML = `<div class="callout" style="border-color:#f5b942;color:#f5b942">The answers differ: ${esc(odd.map(r => r.label).join(", "))} ${odd.length === 1 ? "has" : "have"} a different answer.${ttl.length ? ` ${odd.length === 1 ? "Its" : "Their"} copy expires in ${Math.max(1, Math.round(Math.max(...ttl) / 60))} minutes (TTL), if it\u2019s an old answer still cached.` : ""}</div>`;
    } else $("cbanner").innerHTML = `<div class="callout" style="border-color:var(--green);color:var(--green-hi)">Every server gives the same answer.</div>`;
    if (zoneInfo?.ns.length) {
      const serials = await soaSerials(zoneInfo.zone, zoneInfo.ns);
      if (!live()) return;
      const uniq = new Set(serials.map(s => s.serial));
      $("csoa").textContent = serials.every(x => x.serial === "(no answer)") ? "Couldn’t read the domain’s name servers’ serial numbers." : uniq.size === 1 ? `The domain’s name servers agree with each other: ${zoneInfo.ns.join(", ")} all have serial ${[...uniq][0]} (zone ${zoneInfo.zone}).`
        : `The domain’s name servers DON’T agree: ${serials.map(s => `${s.ns} ${s.serial}`).join(", ")}. One may not have the latest changes.`;
    }
    mark("compare", cmp.differ || $("csoa").textContent.includes("DON’T") ? "warn" : "done");
  });
  $("cgo").onclick = runCompare;
  refreshers.push(saveToOrgButton($("csave2"), () => cmp ? { kind: "dns", title: `Compare servers · ${cmpAsked}`, summary: cmp.differ ? "answers differ" : "all servers agree",
    table: { header: ["Server", "Answer", "TTL", "Time (ms)"], rows: cmp.rows.map(r => [r.label, r.answer + (r.different ? " (different)" : ""), r.ttl ?? "", r.ms ?? ""].map(String)), widths: [34, 50, 8, 10], numberColumns: [2, 3] } } : null,
    { enabled: () => !!cmp }));

  // --- Expiry
  let exRes = null, exDomain = "";
  const tileHtml = (label, value, sub, days) => `<div class="tile"><div class="label">${esc(label)}</div><div class="value" style="font-size:20px" class="">${value}</div><div class="note">${esc(sub)}</div></div>`;
  const colour = d => d == null ? "" : d < 0 ? "poor" : d < 30 ? "fair" : "good";
  const runExpiry = guarded("expiry", async live => {
    const d = base(); if (!d || isAddress(d)) return;
    exDomain = d; $("xlabel").textContent = `Expiry for ${d}`; mark("expiry", "running"); $("xst").textContent = "Checking registration and certificates…"; $("xrows").innerHTML = ""; $("xtiles").innerHTML = ""; exRes = null;
    const res = await expiryCheck(d, "");
    if (!live()) return;
    exRes = res; $("xst").textContent = "";
    const fmt = iso => iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "unknown";
    const r = exRes.reg.ok ? exRes.reg.r : null, rd = daysLeft(r?.expires);
    const soon = exRes.certs.filter(c => c.expires).sort((a, b) => a.expires.localeCompare(b.expires))[0], sd = daysLeft(soon?.expires);
    $("xtiles").innerHTML = `<div class="tile"><div class="label">Domain registration</div><div class="value ${colour(rd)}" style="font-size:20px">${esc(r ? fmt(r.expires) : "unknown")}</div><div class="note">${esc(r ? `${rd != null ? `in ${rd} days · ` : ""}${r.registrar}` : exRes.reg.error)}</div></div>
      <div class="tile"><div class="label">Soonest certificate</div><div class="value ${colour(sd)}" style="font-size:20px">${esc(soon ? fmt(soon.expires) : "none found")}</div><div class="note">${esc(soon ? `${sd < 0 ? "EXPIRED" : `in ${sd} days`} · ${soon.host}` : "")}</div></div>
      <div class="tile"><div class="label">Name servers</div><div class="value" style="font-size:14px;margin-top:4px">${esc(r ? r.nameServers.join(", ") || "unknown" : "unknown")}</div><div class="note">${esc(r && r.dnssec != null ? `DNSSEC: ${r.dnssec ? "signed" : "not signed"}` : "")}</div></div>`;
    $("xrows").innerHTML = exRes.certs.map(c => { const dd = daysLeft(c.expires);
      return `<tr style="${dd != null && dd < 30 ? "background:color-mix(in srgb, #f5b942 12%, transparent)" : ""}"><td>${esc(c.host)}${c.port !== 443 ? ":" + c.port : ""}</td>
        <td class="${c.expires ? colour(dd) : "note"}">${esc(c.expires ? `${fmt(c.expires)}${dd < 0 ? " (EXPIRED)" : dd < 30 ? ` (${dd} days)` : ""}` : c.problem)}</td><td>${esc(c.issuer)}</td>
        <td class="note">${c.expires && !c.coversHost ? '<b class="poor">Doesn’t cover this name.</b> ' : ""}${esc(c.names.length > 3 ? `${c.names.slice(0, 3).join(", ")} and ${c.names.length - 3} more` : c.names.join(", "))}</td></tr>`; }).join("")
      || `<tr><td colspan="4" class="note">None of the usual host names answered.</td></tr>`;
    const days = [r?.expires, ...exRes.certs.map(c => c.expires)].map(daysLeft).filter(x => x != null);
    mark("expiry", !r || days.some(x => x < 30) || exRes.certs.some(c => c.expires && !c.coversHost) ? "warn" : "done");
  });
  $("xgo").onclick = runExpiry;

  // --- Check all: the one domain box runs every domain tab. An IP address only gets its name (Look Up).
  const checkAll = () => {
    const h = host(); if (!h) return;
    if (isAddress(h)) {
      $("dt").value = "PTR";
      for (const k of ["email", "compare", "expiry"]) mark(k, "");
      lookUp(); return;
    }
    if ($("dt").value === "PTR") $("dt").value = "All";
    lookUp(); runEmail(); runCompare(); runExpiry();
  };
  // Stop: every tab that's running drops what it's still waiting for.
  const stopAll = () => {
    for (const k of Object.keys(runs)) runs[k]++;
    lookBusy = false;
    const statusOf = { lookup: "dst", email: "est", compare: "cst", expiry: "xst" };
    for (const k of Object.keys(statusOf)) if ($(`m-${k}`).classList.contains("running")) { mark(k, ""); $(statusOf[k]).textContent = "Stopped"; }
    if (/…$/.test($("rst").textContent)) $("rst").textContent = "Stopped";
  };
  $("dall").onclick = () => active > 0 ? stopAll() : checkAll();
  refreshers.push(saveToOrgButton($("xsave"), () => exRes ? Drafts.expiry(exDomain, expiryRows(exRes)) : null, { enabled: () => !!exRes }));

  // --- Reverse Subnet
  let rev = [], revRange = "";
  const drawRev = () => {
    const list = $("rall").checked ? rev : rev.filter(r => r.name);
    $("rrows").innerHTML = list.map(r => `<tr><td class="mono">${esc(r.ip)}</td><td>${r.name ? esc(r.name) : '<span class="note">(no name)</span>'}</td></tr>`).join("");
    $("rcsv").disabled = !rev.length;
  };
  const runReverse = guarded("reverse", async live => {
    const range = $("rn2").value.trim(); if (!range) return;
    revRange = range; rev = []; drawRev(); $("rst").textContent = "Asking…";
    const t0 = Date.now();
    let found;
    try { found = await reverseSubnet(range, $("rs2").value.trim(), (d, n) => { if (live()) $("rst").textContent = `Asked ${d} of ${n}…`; }, live); }
    catch (e) { if (live()) $("rst").textContent = String(e); return; }
    if (!live()) return;
    rev = found;
    $("rst").textContent = `${rev.filter(r => r.name).length} of ${rev.length} addresses have a name · ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    drawRev();
  });
  $("rgo").onclick = runReverse; $("rn2").onkeydown = e => { if (e.key === "Enter") runReverse(); };
  $("rall").onchange = drawRev;
  $("rcsv").onclick = () => download("csv", `Reverse ${revRange}`, ["IP", "Name"], rev.map(r => [r.ip, r.name])).catch(() => {});
  refreshers.push(saveToOrgButton($("rsave"), () => rev.length ? { kind: "dns", title: `Reverse lookup · ${revRange}`, summary: `${rev.filter(r => r.name).length} of ${rev.length} addresses have a name`,
    table: { header: ["IP", "Name"], rows: rev.filter(r => r.name).map(r => [r.ip, r.name]), widths: [16, 60] } } : null, { enabled: () => rev.length > 0 }));

  setInterval(() => { refreshD(); refreshers.forEach(f => f()); }, 1000);
  showTab(arg ? "lookup" : tab);
  if (arg) { $("dt").value = isIPv4(arg) ? "PTR" : "All"; lookUp(); }
  return a => { showTab("lookup"); $("dq").value = a; $("dt").value = isIPv4(a) ? "PTR" : "All"; lookUp(); };
}

// MARK: Wi-Fi Signal

const quality = r => r >= -67 ? "good" : r >= -75 ? "fair" : "poor";
const LOCATION_NOTE = `<div class="callout"><b>Windows is hiding Wi-Fi details</b>
  <span>Windows 11 only shows Wi-Fi network names and the nearby-network list to apps after you allow Location for desktop apps. ARPradar never reads your location; this is only how Windows guards Wi-Fi details.</span>
  <span>Settings › Privacy &amp; security › Location: turn on <b>Location services</b> and <b>Let desktop apps access your location</b>.</span>
  <div><button type="button" class="btn" id="locset">Open Location Settings</button></div></div>`;

function wifiTool(root) {
  document.title = "Wi-Fi Signal";
  root.innerHTML = `<div class="bar"><span class="grow"></span><span id="wsave"></span></div><div id="wbody"></div><canvas class="chart" id="wc"></canvas>
    <p class="note">Last 2 minutes, in dBm (closer to 0 is stronger). Green band = good (−67 dBm or better). Orange line = moved to another access point.</p>`;
  const samples = [], roams = [];
  let lastBssid = "", lastStatus = null;
  saveToOrgButton($("wsave"), () => Drafts.wifiSignal(wifiRows(lastStatus)), { enabled: () => wifiRows(lastStatus).length > 0, auto: false });
  const tick = async () => {
    const s = await invoke("wifi_status").catch(() => ({ state: "unsupported" }));
    lastStatus = s;
    const now = Date.now();
    let html = "";
    if (s.state === "unsupported") html = `<p class="status">Wi-Fi isn’t available on this computer.</p>`;
    else if (s.state === "off") html = `<p class="status">Wi-Fi is off or not connected.</p>`;
    else {
      if (s.bssid && lastBssid && s.bssid !== lastBssid) roams.push(now);
      if (s.bssid) lastBssid = s.bssid;
      samples.push({ t: now, v: s.rssi });
      while (samples.length && samples[0].t < now - 120000) samples.shift();
      html = `<div class="big">
          <div class="tile"><div class="label">Signal</div><div class="value ${quality(s.rssi)}">${s.rssi}<span class="unit">dBm</span></div></div>
          <div class="tile"><div class="label">Quality</div><div class="value">${s.quality}<span class="unit">%</span></div></div>
          <div class="tile"><div class="label">Speed (receive / send)</div><div class="value">${fmt(s.rxMbps)}<span class="unit">/ ${fmt(s.txMbps)} Mbps</span></div></div></div>
        <dl class="kv"><dt>Network</dt><dd>${esc(s.ssid || "(hidden by Windows)")}</dd><dt>Access point</dt><dd class="mono">${esc(s.bssid || "(hidden by Windows)")}</dd>
          <dt>Channel</dt><dd>${s.channel ? `${s.channel}${s.band ? " · " + s.band : ""}${s.widthMhz ? " · " + s.widthMhz + " MHz" : ""}` : "–"}</dd>
          <dt>Security</dt><dd>${esc(s.security || "–")}</dd><dt>Adapter</dt><dd>${esc(s.adapter)}</dd>${roams.length ? `<dt>Roamed</dt><dd>${roams.length} time${roams.length === 1 ? "" : "s"}</dd>` : ""}</dl>`;
      if (s.state === "location") html += LOCATION_NOTE;
    }
    $("wbody").innerHTML = html;
    if ($("locset")) $("locset").onclick = () => invoke("open_location_settings");
    drawChart($("wc"), [{ color: COLORS[1], points: samples }], { tMin: now - 120000, tMax: now, yMin: -100, yMax: -20, band: [-67, -20], markers: roams.filter(r => r > now - 120000), yLabel: "dBm" });
  };
  tick(); setInterval(tick, 1000);
}

// MARK: Wi-Fi Analyzer

/// The centre of a wide channel (Windows reports the primary 20 MHz channel).
function centre(ch, width, band) {
  if (width <= 20) return ch;
  if (band === "6 GHz") { const size = width / 20, start = Math.floor((ch - 1) / 4 / size) * size; return 1 + 4 * start + 2 * (size - 1); }
  if (band === "5 GHz") {
    const blocks = { 40: [[36, 40], [44, 48], [52, 56], [60, 64], [100, 104], [108, 112], [116, 120], [124, 128], [132, 136], [140, 144], [149, 153], [157, 161], [165, 169]],
      80: [[36, 48], [52, 64], [100, 112], [116, 128], [132, 144], [149, 161], [165, 177]], 160: [[36, 64], [100, 128], [149, 177]] };
    const r = (blocks[width] || []).find(([a, b]) => ch >= a && ch <= b);
    if (r) return (r[0] + r[1]) / 2;
  }
  if (band === "2.4 GHz" && width === 40) return ch <= 7 ? ch + 2 : ch - 2;
  return ch;
}

function analyzerTool(root) {
  document.title = "Wi-Fi Analyzer";
  const bands = ["2.4 GHz", "5 GHz", "6 GHz"];
  let band = load("analyzerBand", "2.4 GHz"), nets = [];
  root.innerHTML = `<div class="bar"><div class="segmented" id="ab" role="group" aria-label="Band"></div><span class="status grow" id="ast">Scanning…</span><span id="asave"></span></div>
    <div id="aprob"></div><canvas class="chart" id="ac" style="height:260px"></canvas>
    <div class="tablebox"><table class="tt"><thead><tr><th>Network</th><th class="num">Signal</th><th class="num">Channel</th><th class="num">Width</th><th>Security</th><th>Access point</th></tr></thead><tbody id="arows"></tbody></table></div>`;
  const draw = () => {
    $("ab").innerHTML = bands.map(b => `<button type="button" class="${b === band ? "on" : ""}" data-b="${b}">${b} (${nets.filter(n => n.band === b).length})</button>`).join("");
    const list = nets.filter(n => n.band === band).sort((a, b) => b.rssi - a.rssi);
    $("arows").innerHTML = list.map(n => `<tr><td>${esc(n.ssid || "(hidden network)")}${n.mine ? ' <span class="badge me">you</span>' : ""}</td><td class="num ${quality(n.rssi)}">${n.rssi} dBm</td>
      <td class="num">${n.channel}</td><td class="num">${n.widthMhz} MHz</td><td>${esc(n.security)}</td><td class="mono">${esc(n.bssid)}</td></tr>`).join("");
    channelChart($("ac"), list, band);
  };
  saveToOrgButton($("asave"), () => Drafts.wifiNetworks(nets, wifiRows(lastSig)), { enabled: () => nets.length > 0, auto: false });
  let lastSig = null;
  $("ab").onclick = e => { const b = e.target.closest("[data-b]"); if (b) { band = b.dataset.b; save("analyzerBand", band); draw(); } };
  const scan = async () => {
    try {
      nets = await invoke("wifi_scan");
      lastSig = await invoke("wifi_status").catch(() => null);
      $("aprob").innerHTML = "";
      $("ast").textContent = `${nets.length} networks · rescans every 10 s`;
    } catch (e) {
      if (String(e) === "location") { $("aprob").innerHTML = LOCATION_NOTE; $("locset").onclick = () => invoke("open_location_settings"); $("ast").textContent = ""; }
      else $("ast").textContent = String(e);
    }
    draw();
  };
  window.addEventListener("resize", draw);
  scan(); setInterval(scan, 10000);
}

function channelChart(canvas, list, band) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const [cMin, cMax, ticks] = band === "2.4 GHz" ? [-1, 15, [1, 6, 11, 14]] : band === "5 GHz" ? [30, 179, [36, 52, 100, 116, 132, 149, 165]] : [-6, 240, [1, 37, 69, 101, 133, 165, 197, 229]];
  const L = 36, R = 10, Tp = 10, B = 22, yMin = -95, yMax = -25;
  const x = c => L + (c - cMin) / (cMax - cMin) * (w - L - R);
  const y = v => Tp + (1 - (v - yMin) / (yMax - yMin)) * (h - Tp - B);
  g.strokeStyle = css("--line"); g.fillStyle = css("--muted"); g.font = "10px Segoe UI, system-ui, sans-serif";
  for (const d of [-90, -80, -70, -60, -50, -40, -30]) { g.beginPath(); g.moveTo(L, y(d)); g.lineTo(w - R, y(d)); g.stroke(); g.fillText(String(d), 4, y(d) + 3); }
  for (const t of ticks) g.fillText(String(t), x(t) - 5, h - 6);
  if (!list.length) { g.textAlign = "center"; g.fillText(`No networks on ${band}`, w / 2, h / 2); g.textAlign = "left"; return; }
  list.forEach((n, i) => {
    const c = centre(n.channel, n.widthMhz, band), half = n.widthMhz / 10;   // channels are 5 MHz apart
    const color = COLORS[i % COLORS.length];
    g.beginPath(); g.moveTo(x(c - half), y(yMin));
    g.bezierCurveTo(x(c - half * 0.6), y(n.rssi), x(c + half * 0.6), y(n.rssi), x(c + half), y(yMin));
    g.fillStyle = color + "22"; g.fill(); g.strokeStyle = color; g.lineWidth = n.mine ? 3 : 1.5; g.stroke();
    g.fillStyle = color; g.fillText(n.ssid || "(hidden)", x(c) - 20, y(n.rssi) - 4);
  });
}

// MARK: Connection Info

async function connectionTool(root) {
  document.title = "Connection Info";
  const adapters = await invoke("list_adapters").catch(() => []);
  root.innerHTML = `<div class="bar"><div class="field grow"><label for="ca">Network adapter</label><select id="ca">${adapters.map(a => `<option value="${esc(a.id)}">${esc(a.displayName)}</option>`).join("")}</select></div>
      <button type="button" id="cref">Refresh</button><button type="button" id="cren" class="advanced-only">Renew DHCP Lease…</button><button type="button" id="ccopy">Copy</button><span id="csave"></span></div>
    <dl class="kv" id="ckv"></dl>
    <div class="bar"><span class="status">Public IP</span><span id="cpub"></span><button type="button" id="cpubgo">Look Up</button><span class="note">asks api.ipify.org once</span></div>`;
  document.body.classList.toggle("basic", !advanced());
  const keep = load("adapter", "");
  if (adapters.some(a => a.id === keep)) $("ca").value = keep;
  let info = null;
  const fmtLease = secs => { if (secs == null) return ""; const d = new Date(Date.now() + secs * 1000); return `${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (in ${secs >= 3600 ? Math.round(secs / 3600) + " h" : Math.round(secs / 60) + " min"})`; };
  const rows = () => info ? [["Adapter", info.adapter], ["Description", info.description], ["IP address", `${info.address}/${info.prefix}`], ["Subnet mask", info.mask], ["Router", info.router],
    ["DHCP", info.dhcp ? "On" : "Off (fixed address)"], ["DHCP server", info.dhcpServer], ["Lease ends", fmtLease(info.leaseLeftSecs)], ["DNS servers", info.dns.join(", ")], ["DNS suffix", info.domain],
    ["IPv6", info.ipv6.join("\n")], ["MAC", info.mac], ["MTU", info.mtu ? String(info.mtu) : ""], ["Link speed", info.linkMbps ? `${info.linkMbps} Mbps` : ""]].filter(r => r[1]) : [];
  const read = async () => {
    info = await invoke("connection_info", { id: $("ca").value }).catch(() => null);
    $("ckv").innerHTML = info ? rows().map(([k, v]) => `<dt>${esc(k)}</dt><dd class="${/IP|MAC|DNS servers|Router|server/.test(k) ? "mono" : ""}" style="white-space:pre-line">${esc(v)}</dd>`).join("")
      : `<dt></dt><dd class="status">Couldn’t read this adapter.</dd>`;
  };
  $("ca").onchange = read; $("cref").onclick = read;
  let pubIp = "";
  saveToOrgButton($("csave"), () => Drafts.connection(connectionRows(info, pubIp), adapters.find(a => a.id === $("ca").value)?.displayName || ""), { enabled: () => !!info });
  $("ccopy").onclick = () => copyText(rows().map(([k, v]) => `${k}: ${v.replace(/\n/g, ", ")}`).join("\n"));
  $("cpubgo").onclick = async () => { $("cpub").textContent = "Asking…"; try { pubIp = await invoke("public_ip"); $("cpub").textContent = pubIp; } catch (e) { $("cpub").textContent = String(e); } };
  $("cren").onclick = () => {
    if (!info) return;
    const m = document.createElement("div");
    m.className = "backdrop";
    m.innerHTML = `<div class="modal"><h2>Renew the DHCP lease on “${esc(info.adapter)}”?</h2><p>Windows asks for permission (admin rights) for this. The connection may drop for a few seconds.</p>
      <div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="primary">Renew</button></div></div>`;
    $("modal-root").appendChild(m);
    m.querySelector("[data-no]").onclick = () => m.remove();
    m.querySelector(".primary").onclick = async () => {
      m.remove();
      $("ckv").insertAdjacentHTML("beforebegin", '<p class="status" id="crenst">Renewing…</p>');
      try { await invoke("renew_dhcp", { adapter: info.adapter }); $("crenst").textContent = "Renewed."; }
      catch (e) { $("crenst").textContent = String(e); }
      setTimeout(() => $("crenst")?.remove(), 6000);
      read();
    };
  };
  read();
}

// MARK: Speed Test

function speedTool(root) {
  document.title = "Speed Test";
  root.innerHTML = `<div class="bar"><button type="button" id="sgo" class="primary">Start Test</button><span class="status grow" id="sst">About 30 seconds. Uses Cloudflare’s speed test servers.</span></div>
    <div class="big"><div class="tile"><div class="label">Download</div><div class="value" id="sdown">–<span class="unit">Mbps</span></div></div>
      <div class="tile"><div class="label">Upload</div><div class="value" id="sup">–<span class="unit">Mbps</span></div></div>
      <div class="tile"><div class="label">Latency (idle / busy)</div><div class="value" id="slat">–<span class="unit">ms</span></div></div></div>
    <div class="tablebox"><table class="tt"><thead><tr><th>When</th><th class="num">Download</th><th class="num">Upload</th><th class="num">Idle</th><th class="num">Busy</th></tr></thead><tbody id="srows"></tbody></table></div>
    <div class="bar"><span id="ssave"></span><span class="note grow">“Busy” latency is measured while downloading: a big jump means the line gets laggy when it’s full (bufferbloat).</span><button type="button" id="sclear">Clear List</button></div>`;
  let history = [];
  try { history = JSON.parse(load("speedTests", "[]")); } catch {}
  let running = false;
  const tile = (id, v, unit, digits = 0) => { $(id).innerHTML = `${v == null ? "–" : fmt(v, digits)}<span class="unit">${unit}</span>`; };
  const drawHistory = () => {
    $("srows").innerHTML = history.map(r => `<tr><td>${esc(new Date(r.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}</td><td class="num">${fmt(r.down)} Mbps</td><td class="num">${fmt(r.up)} Mbps</td><td class="num">${fmt(r.idle)} ms</td><td class="num">${fmt(r.loaded)} ms</td></tr>`).join("");
    $("sclear").disabled = !history.length;
  };
  const setRunning = on => { running = on; busy("speed", on); $("sgo").textContent = on ? "Stop" : "Start Test"; $("sgo").className = on ? "stop" : "primary"; };
  T.event.listen("speed", e => {
    const ev = e.payload;
    if (ev.kind === "phase") $("sst").textContent = { latency: "Measuring latency…", download: "Testing download…", upload: "Testing upload…" }[ev.phase];
    if (ev.kind === "live") tile(ev.phase === "download" ? "sdown" : "sup", ev.mbps, "Mbps");
    if (ev.kind === "failed") { setRunning(false); $("sst").textContent = ev.message; }
    if (ev.kind === "done") {
      setRunning(false);
      tile("sdown", ev.downMbps, "Mbps"); tile("sup", ev.upMbps, "Mbps");
      $("slat").innerHTML = `${fmt(ev.idleMs)}<span class="unit">/ ${fmt(ev.loadedMs)} ms</span>`;
      $("sst").textContent = "Done.";
      history.unshift({ date: new Date().toISOString(), down: ev.downMbps, up: ev.upMbps, idle: ev.idleMs, loaded: ev.loadedMs });
      history = history.slice(0, 50); save("speedTests", JSON.stringify(history)); drawHistory();
    }
  });
  $("sgo").onclick = () => {
    if (running) { invoke("job_stop", { key: "speed" }); return; }
    setRunning(true); tile("sdown", null, "Mbps"); tile("sup", null, "Mbps"); tile("slat", null, "ms");
    $("sst").textContent = "Starting…";
    invoke("speed_start");
  };
  saveToOrgButton($("ssave"), () => history[0] ? Drafts.speed(history[0], localStorage.getItem("currentSiteName") || "") : null, { enabled: () => history.length > 0 && !running });
  $("sclear").onclick = () => { history = []; save("speedTests", "[]"); drawHistory(); };
  drawHistory();
}

// MARK: Subnet Calculator

const ipNum = ip => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0) >>> 0;
const ipText = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
function subnetInfo(text) {
  const parts = text.trim().split(/[\/\s]+/).filter(Boolean);
  if (!parts.length || !isIPv4(parts[0])) return null;
  let prefix = 32;
  if (parts[1] !== undefined) {
    if (/^\d+$/.test(parts[1]) && Number(parts[1]) <= 32) prefix = Number(parts[1]);
    else if (isIPv4(parts[1])) {
      const m = ipNum(parts[1]), bits = m.toString(2).replace(/0/g, "").length;
      if (bits && ((~0 << (32 - bits)) >>> 0) !== m) return null;   // the 1s must be contiguous
      prefix = bits;
    } else return null;
  }
  const addr = ipNum(parts[0]);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const net = (addr & mask) >>> 0, bc = (net | ~mask) >>> 0;
  const inNet = (n, p) => ((addr & ((~0 << (32 - p)) >>> 0)) >>> 0) === ipNum(n);
  const kind = inNet("10.0.0.0", 8) || inNet("172.16.0.0", 12) || inNet("192.168.0.0", 16) ? "Private (RFC 1918)"
    : inNet("100.64.0.0", 10) ? "Carrier-grade NAT (RFC 6598)" : inNet("169.254.0.0", 16) ? "Link-local (no DHCP answer)"
    : inNet("127.0.0.0", 8) ? "Loopback" : inNet("224.0.0.0", 4) ? "Multicast" : "Public";
  return { address: ipText(addr), prefix, mask: ipText(mask), wildcard: ipText(~mask >>> 0), network: ipText(net), broadcast: ipText(bc),
    first: prefix >= 31 ? ipText(net) : ipText(net + 1), last: prefix >= 31 ? ipText(bc) : ipText(bc - 1),
    hosts: prefix >= 31 ? (prefix === 31 ? 2 : 1) : 2 ** (32 - prefix) - 2, kind, cidr: `${ipText(net)}/${prefix}` };
}

function subnetTool(root, arg) {
  document.title = "Subnet Calculator";
  root.innerHTML = `<div class="bar"><div class="field grow"><label for="si">Address with /prefix or a mask</label><input id="si" class="mono" placeholder="172.16.8.20/22 or 172.16.8.20 255.255.252.0" spellcheck="false"></div></div>
    <dl class="kv" id="skv"></dl><div class="bar"><button type="button" id="sscan" class="primary" hidden>Scan This Range</button><button type="button" id="scopy" hidden>Copy</button></div>`;
  $("si").value = arg || load("subnetInput", "");
  let info = null;
  const rows = () => info ? [["Network", info.cidr], ["Subnet mask", info.mask], ["Wildcard", info.wildcard], ["First host", info.first], ["Last host", info.last],
    ["Broadcast", info.broadcast], ["Usable hosts", info.hosts.toLocaleString()], ["Kind", info.kind]] : [];
  const calc = () => {
    save("subnetInput", $("si").value);
    info = subnetInfo($("si").value);
    $("skv").innerHTML = info ? rows().map(([k, v]) => `<dt>${k}</dt><dd class="mono">${esc(v)}</dd>`).join("") : `<dt></dt><dd class="status">Type an address with /prefix or a mask.</dd>`;
    $("sscan").hidden = $("scopy").hidden = !info;
    $("sscan").disabled = info && info.hosts > 65536;
    $("sscan").title = info && info.hosts > 65536 ? "Too big to scan (over 65,536 addresses)" : "";
  };
  $("si").oninput = calc;
  $("scopy").onclick = () => copyText(rows().map(([k, v]) => `${k}: ${v}`).join("\n"));
  $("sscan").onclick = () => info && invoke("scan_range_in_main", { range: `${info.first}-${info.last}` });
  calc();
}

// MARK: Settings

function settingsTool(root) {
  document.title = "ARPradar Settings";
  const seg = (key, def, opts) => `<div class="segmented" data-key="${key}">${opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${load(key, def) === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
  const THEMES = [["radar", "Radar", "Matches the icon"], ["ocean", "Ocean", "Soft blue-teal"], ["sunset", "Sunset", "Warm orange"], ["graphite", "Graphite", "Quiet grey"], ["contrast", "High contrast", "Easiest to read"]];
  root.innerHTML = `<div class="segmented" id="stabs" style="align-self:flex-start"><button type="button" data-t="general" class="on">General</button><button type="button" data-t="appearance">Appearance</button></div>
    <section id="s-general" class="settings">
      <label class="check"><input type="checkbox" id="stype"> Show the Type column</label>
      <label class="check"><input type="checkbox" id="sswitch"> Show the Switch port column</label>
      <p class="note">Switch port shows where each device plugs in (switch and port, or access point for Wi-Fi). It needs a UniFi controller: see the Map tab.</p>
      <hr>
      <label class="check"><input type="checkbox" id="snotify"> Notify me about new devices</label>
      <p class="note">After a scan of a saved scan, a Windows notification lists devices it has never seen before.</p>
      <label class="check"><input type="checkbox" id="stray"> Show ARPradar in the system tray</label>
      <p class="note">A radar icon by the clock: Scan Now, Ping and Speed Test, without opening the main window.</p>
      <label class="check" style="margin-left:24px"><input type="checkbox" id="skeep"> Keep running in the tray when the main window is closed</label>
      <p class="note">The SNMP community is set per organization (its Settings) or per standalone saved scan (Saved Scans › Edit This Scan…), so it is only sent on that network.</p>
    </section>
    <section id="s-appearance" class="settings" hidden>
      <div class="field"><span class="label">Mode</span>${seg("appearance", "dark", [["auto", "Auto (follow Windows)"], ["light", "Light"], ["dark", "Dark"]])}</div>
      <div class="field"><span class="label">Theme</span><div class="themes">${THEMES.map(([v, t, sub]) => `<button type="button" class="theme ${load("theme", "radar") === v ? "on" : ""}" data-theme-pick="${v}"><span class="sw sw-${v}"></span><b>${t}</b><small>${sub}</small></button>`).join("")}</div></div>
      <div class="field"><span class="label">Row height</span>${seg("rowDensity", "regular", [["compact", "Compact"], ["regular", "Regular"], ["roomy", "Roomy"]])}</div>
      <div class="field"><span class="label">Text size</span>${seg("textSize", "medium", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]])}</div>
      <p class="note">Themes change colours only; the layout stays the same. Row height and text size apply to the device list and details panel.</p>
    </section>`;
  const changed = () => { window.applyLook?.(); try { T.event.emit?.("settings-changed", {})?.catch(() => {}); } catch {} };
  $("stabs").onclick = e => { const b = e.target.closest("[data-t]"); if (!b) return;
    $("stabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    $("s-general").hidden = b.dataset.t !== "general"; $("s-appearance").hidden = b.dataset.t !== "appearance"; };
  root.querySelectorAll(".segmented[data-key]").forEach(g => g.onclick = e => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    save(g.dataset.key, b.dataset.v); g.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); changed();
  });
  root.querySelectorAll("[data-theme-pick]").forEach(b => b.onclick = () => {
    save("theme", b.dataset.themePick); root.querySelectorAll("[data-theme-pick]").forEach(x => x.classList.toggle("on", x === b)); changed();
  });
  $("snotify").checked = load("notifyNew", "0") === "1";
  $("stype").checked = load("showTypeColumn", "1") === "1";
  $("sswitch").checked = load("showSwitchPortColumn", "0") === "1";
  $("stype").onchange = () => { save("showTypeColumn", $("stype").checked ? "1" : "0"); changed(); };
  $("sswitch").onchange = () => { save("showSwitchPortColumn", $("sswitch").checked ? "1" : "0"); changed(); };
  $("stray").checked = load("tray", "0") === "1";
  $("skeep").checked = load("trayKeep", "1") === "1";
  const tray = () => { $("skeep").disabled = !$("stray").checked; invoke("set_tray", { on: $("stray").checked, keepRunning: $("skeep").checked }).catch(() => {}); changed(); };
  $("snotify").onchange = () => { save("notifyNew", $("snotify").checked ? "1" : "0"); changed(); };
  $("stray").onchange = () => { save("tray", $("stray").checked ? "1" : "0"); tray(); };
  $("skeep").onchange = () => { save("trayKeep", $("skeep").checked ? "1" : "0"); tray(); };
  $("skeep").disabled = !$("stray").checked;
}

// MARK: Wake Remote PC

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).toUpperCase();
const normMac = t => { const h = t.toUpperCase().replace(/[^0-9A-F]/g, ""); return h.length === 12 && !/[G-Z]/i.test(t.replace(/[0-9A-F:.\-\s]/gi, "")) ? h.match(/../g).join(":") : null; };
function blankPC() { return { id: newId(), name: "", site: "", mac: "", ip: "", prefix: 24, sendToIP: true, sendToBroadcast: true, useRelay: false, relay: "", port: 9, checkAfter: true }; }
const pcName = t => t.name || t.ip || "New PC";
function broadcastOf(ip, prefix) {
  if (!isIPv4(ip) || !(prefix >= 8 && prefix <= 30)) return null;
  const n = ip.split(".").reduce((a, o) => a * 256 + Number(o), 0) >>> 0;
  const b = (n | (~((~0 << (32 - prefix)) >>> 0) >>> 0)) >>> 0;
  return [b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join(".");
}

async function remoteWakeTool(root, arg) {
  document.title = "Wake Remote PC";
  let list = [];
  const loadList = async () => { try { list = JSON.parse(await invoke("load_file", { name: "remote-wake" }) || "[]"); } catch { list = []; } };
  await loadList();
  let picked = new Set(arg ? [arg] : list[0] ? [list[0].id] : []);
  const status = {}, checks = {};
  let saveTimer = null;
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => invoke("save_file", { name: "remote-wake", json: JSON.stringify(list, null, 2) }), 400); };
  root.innerHTML = `<div class="scanlist" style="flex:1"><div class="scanlist-items" style="max-height:none;display:flex;flex-direction:column">
      <div class="heading" style="padding:8px 10px 4px;color:var(--muted);font-size:11px;font-weight:600">SAVED PCs</div><div id="rlist" style="flex:1;overflow:auto"></div>
      <div class="bar" style="padding:6px;border-top:1px solid var(--line)"><button type="button" id="radd" title="Add a PC">+ Add</button><button type="button" id="rdel" title="Delete the selected PCs">− Delete</button></div></div>
    <div class="scanlist-edit" id="redit"></div></div>
    <p class="note"><b>How it gets there:</b> the packet goes out through your VPN like any other traffic. Sending to the PC’s IP works if the client’s router still has the PC in its ARP table. The broadcast works only if that router forwards directed broadcasts. Sending both gives the best chance.</p>`;
  const drawList = () => {
    $("rlist").innerHTML = list.map(t => `<button type="button" data-id="${esc(t.id)}" class="${picked.has(t.id) ? "on" : ""}">${esc(pcName(t))}<small>${esc([t.site, t.ip].filter(Boolean).join(" · "))}${status[t.id] ? " · " + esc(status[t.id].headline) : ""}</small></button>`).join("")
      || `<p class="note" style="padding:10px">No saved PCs yet.</p>`;
    $("rdel").disabled = !picked.size;
  };
  const statusBox = id => `<div id="rst-${esc(id)}">${statusInner(id)}</div>`;
  const statusInner = id => { const s = status[id]; if (!s) return ""; const cls = { awake: "good", waiting: "fair", sending: "fair", noAnswer: "poor", failed: "poor", sent: "" }[s.state];
    return `<div class="callout"><b class="${cls}">${esc(s.headline)}</b>${s.lines.map(l => `<span>${esc(l)}</span>`).join("")}</div>`; };
  const drawEdit = () => {
    const one = picked.size === 1 ? list.find(t => picked.has(t.id)) : null;
    if (!one) {
      $("redit").innerHTML = picked.size > 1 ? `<h2 style="margin:0">${picked.size} PCs selected</h2><div><button type="button" class="btn primary" id="rwakeall">Wake All ${picked.size}</button></div>${[...picked].map(statusBox).join("")}`
        : `<p class="note">Add a PC, or right-click a device in a scan and choose “Save for Remote Wake…”.</p><div><button type="button" class="btn primary" id="radd2">Add a PC</button></div>`;
      if ($("rwakeall")) $("rwakeall").onclick = () => list.filter(t => picked.has(t.id)).forEach(wake);
      if ($("radd2")) $("radd2").onclick = add;
      return;
    }
    const bc = broadcastOf(one.ip, Number(one.prefix));
    $("redit").innerHTML = `
      <div class="field"><label for="rn">Name</label><input id="rn" value="${esc(one.name)}" placeholder="Front desk PC"></div>
      <div class="field"><label for="rs">Client / site</label><input id="rs" value="${esc(one.site)}" placeholder="Client name"></div>
      <div class="field"><label for="rm">MAC address</label><input id="rm" class="mono" value="${esc(one.mac)}" placeholder="Paste from your RMM, any format" spellcheck="false"><span class="problem" id="rmerr" ${!one.mac || normMac(one.mac) ? "hidden" : ""}>Needs 12 hex digits, like 3C-52-82-1A-7E-09</span></div>
      <div class="bar"><div class="field grow"><label for="ri">IP address</label><input id="ri" class="mono" value="${esc(one.ip)}" placeholder="10.20.30.45" spellcheck="false"></div>
        <div class="field"><label for="rp">Subnet (/)</label><input id="rp" type="number" min="8" max="30" value="${esc(one.prefix)}" style="width:70px"></div></div>
      <div class="field"><span class="label">Send to</span>
        <label class="check"><input type="checkbox" id="rsi" ${one.sendToIP ? "checked" : ""}> The PC’s IP <span class="note">${isIPv4(one.ip) ? "(" + esc(one.ip) + ")" : ""}</span></label>
        <label class="check"><input type="checkbox" id="rsb" ${one.sendToBroadcast ? "checked" : ""}> Its subnet broadcast <span class="note">${bc ? "(" + bc + ")" : ""}</span></label>
        <label class="check"><input type="checkbox" id="rsr" ${one.useRelay ? "checked" : ""}> Another relay address: <input id="rr" class="mono" value="${esc(one.relay)}" placeholder="10.20.30.1" style="width:140px;height:26px" spellcheck="false"></label></div>
      <div class="bar"><div class="field"><label for="rport">UDP port</label><input id="rport" type="number" min="1" max="65535" value="${esc(one.port)}" style="width:90px"></div><span class="note">9 is standard; some setups use 7</span></div>
      <label class="check"><input type="checkbox" id="rck" ${one.checkAfter ? "checked" : ""}> Check for 2 minutes and tell me when it wakes up</label>
      <div class="bar"><button type="button" id="rdel1">Delete</button><span class="grow"></span><button type="button" class="primary" id="rwake">Wake</button></div>
      ${statusBox(one.id)}`;
    const q = id => $(id);
    $("redit").oninput = () => {
      Object.assign(one, { name: q("rn").value, site: q("rs").value, mac: q("rm").value, ip: q("ri").value.trim(), prefix: Number(q("rp").value) || 24,
        sendToIP: q("rsi").checked, sendToBroadcast: q("rsb").checked, useRelay: q("rsr").checked, relay: q("rr").value.trim(), port: Number(q("rport").value) || 9, checkAfter: q("rck").checked });
      q("rmerr").hidden = !one.mac || !!normMac(one.mac);
      persist(); drawList();
    };
    q("rm").onblur = () => { const m = normMac(one.mac); if (m && m !== one.mac) { one.mac = m; q("rm").value = m; persist(); } };
    q("rdel1").onclick = () => del(new Set([one.id]));
    q("rwake").onclick = () => wake(one);
  };
  const draw = () => { drawList(); drawEdit(); };
  const add = () => { const t = blankPC(); list.push(t); picked = new Set([t.id]); persist(); draw(); $("rn")?.focus(); };
  const del = ids => {
    const n = ids.size;
    const m = document.createElement("div"); m.className = "backdrop";
    m.innerHTML = `<div class="modal"><h2>Delete ${n === 1 ? "“" + esc(pcName(list.find(t => ids.has(t.id)))) + "”" : n + " PCs"}?</h2><p>They’re removed from the saved list. This can’t be undone.</p>
      <div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="danger">Delete</button></div></div>`;
    $("modal-root").appendChild(m);
    m.querySelector("[data-no]").onclick = () => m.remove();
    m.querySelector(".danger").onclick = () => { m.remove(); for (const id of ids) { clearTimeout(checks[id]); delete status[id]; } list = list.filter(t => !ids.has(t.id)); picked = new Set(); persist(); draw(); };
  };
  async function wake(t) {
    clearTimeout(checks[t.id]);
    // Only the list and this PC's status box redraw, so typing in the form isn't interrupted.
    const set = (state, headline, lines) => {
      status[t.id] = { state, headline, lines };
      drawList();
      const box = document.getElementById(`rst-${t.id}`);
      if (box) box.innerHTML = statusInner(t.id);
    };
    const mac = normMac(t.mac);
    if (!mac) return set("failed", "Not sent", ["The MAC address isn’t valid. Paste it in any format, like 3C-52-82-1A-7E-09 or 3c52821a7e09."]);
    if (!isIPv4(t.ip)) return set("failed", "Not sent", ["The PC’s IP address isn’t valid."]);
    const dests = [];
    if (t.sendToIP) dests.push(t.ip);
    if (t.sendToBroadcast) { const b = broadcastOf(t.ip, Number(t.prefix)); if (!b) return set("failed", "Not sent", ["The subnet must be a number from 8 to 30 (24 means 255.255.255.0)."]); dests.push(b); }
    if (t.useRelay) { if (!isIPv4(t.relay)) return set("failed", "Not sent", ["The relay address isn’t a valid IP address."]); dests.push(t.relay); }
    const uniq = [...new Set(dests)];
    set("sending", "Sending", []);
    try { await invoke("remote_wake_send", { mac, destinations: uniq, port: Number(t.port) || 9 }); }
    catch (e) { return set("failed", "Not sent", [String(e)]); }
    const sent = `Sent 3 magic packets to ${uniq.join(" and ")}, port ${t.port}`;
    if (!t.checkAfter) return set("sent", "Sent", [sent]);
    busy(`wake-${t.id}`, true);
    const start = Date.now();
    set("waiting", "Waiting", [sent, `Checking ${t.ip} every 5 s…`]);
    const check = async () => {
      const awake = await invoke("is_awake", { ip: t.ip }).catch(() => false);
      const secs = Math.round((Date.now() - start) / 1000);
      if (awake) { busy(`wake-${t.id}`, false); return set("awake", "Awake", [sent, `${pcName(t)} ${secs <= 3 ? "answered right away (it may already have been on)" : `answered after ${secs} seconds`}.`]); }
      if (secs >= 120) { busy(`wake-${t.id}`, false); return set("noAnswer", "No answer", [sent, `${t.ip} didn’t answer ping or open RDP, file sharing or SSH within 2 minutes.`]); }
      set("waiting", "Waiting", [sent, `Checking ${t.ip} every 5 s… ${secs} s so far`]);
      checks[t.id] = setTimeout(check, 5000);
    };
    check();
  }
  $("rlist").onclick = e => {
    const b = e.target.closest("[data-id]"); if (!b) return;
    if (e.ctrlKey || e.metaKey) picked.has(b.dataset.id) ? picked.delete(b.dataset.id) : picked.add(b.dataset.id);
    else picked = new Set([b.dataset.id]);
    draw();
  };
  $("radd").onclick = add;
  $("rdel").onclick = () => picked.size && del(new Set(picked));
  draw();
  // The main window saved a device for remote wake: reload the list and pick it.
  return async id => { await loadList(); picked = new Set([id]); draw(); };
}

// MARK: Organizations (the Mac's OrganizationsView: organizations on the left, the chosen one on the right)

async function orgsTool(root, arg) {
  document.title = "Organizations";
  let sites = [];
  const loadSites = async () => { try { sites = JSON.parse(await invoke("load_data") || "{}").sites || []; } catch { sites = []; } };
  await loadSites();
  // UniFi controllers (unifi.json; the keys are in Credential Manager): the Settings box shows the organization's.
  let unifi = [];
  const loadUnifi = async () => { try { unifi = JSON.parse(await invoke("load_file", { name: "unifi" }) || "[]"); } catch { unifi = []; } if (!Array.isArray(unifi)) unifi = []; };
  await loadUnifi();
  let selected = arg || localStorage.getItem("currentOrgId") || Orgs.list[0]?.id || null;
  if (!Orgs.org(selected)) selected = Orgs.list[0]?.id || null;
  let filter = "everything", picked = new Set();
  const act = (action, value) => invoke("org_action", { action, value: value || "" });
  root.innerHTML = `<div class="scanlist" style="flex:1;min-height:0"><div class="scanlist-items" style="max-height:none;display:flex;flex-direction:column">
      <div style="padding:8px 10px 4px;color:var(--muted);font-size:11px;font-weight:600">ORGANIZATIONS</div><div id="olist" style="flex:1;overflow:auto"></div>
      <div class="bar" style="padding:6px;border-top:1px solid var(--line)"><button type="button" id="oadd">+ New Organization…</button></div></div>
    <div class="scanlist-edit" id="odetail" style="min-width:0"></div></div>`;
  const sitesOf = id => sites.filter(x => x.orgID === id).sort((a, b) => a.name.localeCompare(b.name));
  const drawList = () => {
    $("olist").innerHTML = Orgs.list.map(o => `<button type="button" data-id="${esc(o.id)}" class="${o.id === selected ? "on" : ""}">${esc(o.name)}
      <small>${sitesOf(o.id).length} scan${sitesOf(o.id).length === 1 ? "" : "s"} · ${Orgs.items(o.id).length} saved</small></button>`).join("")
      || `<p class="note" style="padding:10px">No organizations yet.</p>`;
  };
  let editTimer = null;
  const drawDetail = () => {
    const o = Orgs.org(selected);
    if (!o) { $("odetail").innerHTML = `<p class="status">${Orgs.list.length ? "Pick an organization on the left." : "No organizations yet."}</p><div><button type="button" class="btn primary" id="oadd2">New Organization…</button></div>`;
      $("oadd2").onclick = () => act("new-org"); return; }
    const all = Orgs.items(o.id);
    const shown = Orgs.timeline(all).filter(r => filter === "everything" || KINDS[r.item.kind]?.group === filter);
    const counts = { everything: all.length }; for (const i of all) counts[KINDS[i.kind]?.group] = (counts[KINDS[i.kind]?.group] || 0) + 1;
    const fmtD = iso => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    $("odetail").innerHTML = `
      <div class="field"><label for="on">Name</label><input id="on" value="${esc(o.name)}" style="font-weight:600"></div>
      <fieldset class="orgsettings"><legend>Settings</legend>
        <div class="field"><label for="od">Domains</label><input id="od" class="mono" value="${esc(o.domains.join(", "))}" placeholder="example.com, example.org" spellcheck="false"></div>
        <div class="bar"><div class="field grow"><label for="ons">Name server</label><input id="ons" class="mono" value="${esc(o.nameServer || "")}" placeholder="Blank = this PC’s DNS, e.g. 10.0.0.5" spellcheck="false"></div>
          <div class="field grow"><label for="odh">DHCP range</label><input id="odh" class="mono" value="${esc(o.dhcpRange || "")}" placeholder="Optional, e.g. 10.0.0.100-10.0.0.199" spellcheck="false"></div>
          <div class="field grow advanced-only"><label for="osnmp">SNMP community</label><input id="osnmp" class="mono" value="${esc(o.snmpCommunity || "")}" placeholder="public" spellcheck="false" autocomplete="off"></div></div>
        <p class="note" id="oserr" style="margin:0">Its scans ask the name server for device names, and tint addresses outside the DHCP range.</p>
        ${o.seenDate && (o.seenDHCPServer || (o.seenNameServers || []).length) ? `<p class="note" style="margin:0">Seen on the last scan (${esc(o.seenScan || "")}, ${esc(fmtD(o.seenDate))}): ${esc([o.seenDHCPServer && `DHCP ${o.seenDHCPServer}`, (o.seenNameServers || []).length && `DNS ${o.seenNameServers.join(", ")}`].filter(Boolean).join(" · "))}</p>` : ""}
        <div class="bar advanced-only" style="align-items:center"><span class="label" style="min-width:auto">UniFi controller</span>
          <span class="note mono grow">${esc(unifi.find(c => c.orgID === o.id)?.address || "None (the Map tab then lists only what the scan finds)")}</span>
          <button type="button" id="ounifi">${unifi.some(c => c.orgID === o.id) ? "Edit…" : "Set Up…"}</button></div>
        <div class="bar" style="align-items:center"><span class="label" style="min-width:auto">Scan style</span>
          <div class="segmented small" id="oquiet"><button type="button" data-q="0" class="${o.quietScan ? "" : "on"}">Normal</button><button type="button" data-q="1" class="${o.quietScan ? "on" : ""}">Quiet</button></div>
          <span class="note grow" style="min-width:0;white-space:normal;overflow:visible;text-overflow:clip">${o.quietScan ? `Every scan and survey for ${esc(o.name)} starts in Quiet: slower, far fewer probes. The survey’s speed test starts unchecked.` : "Quiet sends far fewer probes (for networks with an IDS or touchy devices). You can still switch any scan in the scan bar."}</span></div>
        <div class="field"><label for="ono">Notes</label><textarea id="ono">${esc(o.notes)}</textarea></div></fieldset>
      <div class="field"><span class="label">Scans</span><div>${sitesOf(o.id).map(x => `<button type="button" class="linkbtn" data-site="${esc(x.id)}" title="Open ${esc(x.name)} in the main window">${esc(x.name)}</button> <span class="note mono">${esc(x.range)}</span>`).join("<br>")
        || '<span class="note">None yet: run a survey, or save a scan to this organization (File › Save Scan…).</span>'}</div></div>
      <div class="bar"><div class="segmented" id="ofilter">${[["everything", "Everything"], ["scans", "Scans"], ["dns", "DNS"], ["ports", "Ports"], ["other", "Other"]].map(([k, t]) =>
        `<button type="button" data-f="${k}" class="${filter === k ? "on" : ""}">${t}${counts[k] ? ` (${counts[k]})` : ""}</button>`).join("")}</div><span class="grow"></span>
        <button type="button" id="onscan">+ New Network Scan</button><button type="button" id="ondns">+ New DNS Lookup</button>
        <button type="button" id="onports" class="advanced-only">+ New Port Scan</button><button type="button" id="onother">+ New… ▾</button></div>
      <div class="tablebox"><table class="tt"><thead><tr><th>When</th><th>Saved</th><th>Result</th></tr></thead><tbody id="oitems">
        ${shown.map(({ item: i, indented }) => `<tr data-item="${esc(i.id)}" class="${picked.has(i.id) ? "sel" : ""}" style="cursor:default">
          <td style="white-space:nowrap">${indented ? "" : esc(fmtD(i.date))}</td>
          <td style="${indented ? "padding-left:24px" : ""}">${i.kind === "survey" ? '<span class="badge me">survey</span> ' : ""}${esc(i.title)}${i.note ? `<br><i class="note">“${esc(i.note)}”</i>` : ""}</td>
          <td class="note">${esc(i.summary)}</td></tr>`).join("") || `<tr><td colspan="3" class="note">${all.length ? "Nothing of this kind saved." : "Nothing saved yet. Run a survey, or use Save to Organization in a tool."}</td></tr>`}
      </tbody></table></div>
      <div class="bar"><button type="button" id="oopen" ${picked.size ? "" : "disabled"}>Open</button><button type="button" id="onote" ${picked.size === 1 ? "" : "disabled"}>Edit Note…</button>
        <button type="button" id="odel" ${picked.size ? "" : "disabled"} title="Deletes the saved results selected in the list (not the organization)">Delete…</button>
        <span class="grow"></span><button type="button" id="osurvey" class="primary">Run Survey…</button><button type="button" id="oexport">Export Organization (Excel)…</button>
        <button type="button" id="odelorg">Delete Organization…</button></div>`;
    const field = () => { clearTimeout(editTimer); editTimer = setTimeout(() => {
      const name = $("on").value.trim(), domains = Orgs.parseDomains($("od").value), notes = $("ono").value;
      const ns = $("ons").value.trim(), dh = $("odh").value.trim(), sc = $("osnmp").value.trim();
      const nsOK = !ns || /^\d{1,3}(\.\d{1,3}){3}$/.test(ns);
      $("oserr").textContent = nsOK ? "Every scan in this organization uses this name server, DHCP range and SNMP community (read-only, for asking its switches, printers and UPSes their name and model; only sent on this organization’s networks)." : "The name server must be an IP address.";
      $("oserr").style.color = nsOK ? "" : "var(--red)";
      Orgs.mutate(d => { const x = d.orgs.find(y => y.id === o.id); if (x) { if (name) x.name = name; x.domains = domains; x.notes = notes; if (nsOK) x.nameServer = ns; x.dhcpRange = dh; x.snmpCommunity = sc; } }).then(drawList);
    }, 600); };
    for (const id of ["on", "od", "ono", "ons", "odh", "osnmp"]) $(id).oninput = field;
    $("odetail").querySelectorAll("[data-site]").forEach(b => b.onclick = () => act("open-site", b.dataset.site));
    $("ofilter").onclick = e => { const b = e.target.closest("[data-f]"); if (b) { filter = b.dataset.f; picked.clear(); drawDetail(); } };
    $("onscan").onclick = () => act("new-scan-for-org", o.id);
    $("ounifi").onclick = () => act("unifi-setup", o.id);
    $("oquiet").onclick = e => { const b = e.target.closest("[data-q]"); if (!b) return;
      const on = b.dataset.q === "1";
      Orgs.mutate(d => { const x = d.orgs.find(y => y.id === o.id); if (x) x.quietScan = on; }).then(() => { o.quietScan = on; drawDetail(); }); };
    $("onscan").title = `Opens a new scan in the main window. Each time it finishes, it’s saved here.`;
    $("ondns").title = `Each lookup is saved here when it finishes.`;
    // Anything started here is saved to this organization automatically when it finishes.
    const openFor = (tool, a) => { OrgLaunch.mark(o.id); return invoke("open_tool", { tool, arg: a || null }); };
    $("onports").onclick = () => act("port-scan-for-org", o.id);
    $("onports").title = "Asks for an IP address, then scans its ports. Saved here when it finishes.";
    $("onother").onclick = () => {
      const m = document.createElement("div"); m.className = "menu";
      const list = [["ping", "Ping…"], ["trace", "Traceroute…"], ["speed", "Speed Test"], ["connection", "Connection Info"], ["wifi", "Wi-Fi Signal"], ["analyzer", "Wi-Fi Analyzer"]];
      m.innerHTML = list.map(([t, l]) => `<button type="button" data-t="${t}">${l}</button>`).join("") + `<hr><div class="heading" style="white-space:normal;max-width:240px">Saved here when they finish. Ping and Wi-Fi keep running: save them with their Save to Organization button.</div>`;
      document.body.appendChild(m);
      const r = $("onother").getBoundingClientRect(); m.style.left = `${Math.min(r.left, innerWidth - m.offsetWidth - 8)}px`; m.style.top = `${r.bottom + 2}px`;
      const close = () => { m.remove(); document.removeEventListener("click", close); };
      setTimeout(() => document.addEventListener("click", close), 0);
      m.onclick = e => { const b = e.target.closest("[data-t]"); if (b) { close(); openFor(b.dataset.t); } };
    };
    $("ondns").onclick = () => {
      if (o.domains.length <= 1) return openFor("dns", o.domains[0]);
      const m = document.createElement("div"); m.className = "menu";
      m.innerHTML = o.domains.map(dm => `<button type="button" data-d="${esc(dm)}">${esc(dm)}</button>`).join("") + `<hr><button type="button" data-d="">Other Name…</button>`;
      document.body.appendChild(m);
      const r = $("ondns").getBoundingClientRect(); m.style.left = `${Math.min(r.left, innerWidth - m.offsetWidth - 8)}px`; m.style.top = `${r.bottom + 2}px`;
      const close = () => { m.remove(); document.removeEventListener("click", close); };
      setTimeout(() => document.addEventListener("click", close), 0);
      m.onclick = e => { const b = e.target.closest("[data-d]"); if (b) { close(); openFor("dns", b.dataset.d); } };
    };
    $("oitems").onclick = e => { const tr = e.target.closest("[data-item]"); if (!tr) return;
      if (e.ctrlKey || e.metaKey) picked.has(tr.dataset.item) ? picked.delete(tr.dataset.item) : picked.add(tr.dataset.item); else picked = new Set([tr.dataset.item]);
      drawDetail(); };
    $("oitems").ondblclick = e => { const tr = e.target.closest("[data-item]"); if (tr) itemView(tr.dataset.item); };
    $("oopen").onclick = () => [...picked].forEach(itemView);
    $("onote").onclick = () => {
      const it = Orgs.item([...picked][0]); if (!it) return;
      ask(`Note for “${it.title}”`, it.note, v => Orgs.mutate(d => { const x = d.items.find(y => y.id === it.id); if (x) x.note = v.trim(); }));
    };
    $("odel").onclick = () => confirmIt(picked.size === 1 ? "Delete this saved item?" : `Delete ${picked.size} saved items?`, "This can’t be undone.", "Delete",
      () => { const ids = new Set(picked); picked.clear(); Orgs.mutate(d => { d.items = d.items.filter(i => !ids.has(i.id)); }); });
    $("osurvey").onclick = () => act("run-survey", o.id);
    $("oexport").onclick = () => exportOrg(o);
    $("odelorg").onclick = () => confirmIt(`Delete “${o.name}”?`, `Its ${all.length} saved items are removed. This can’t be undone. Its saved scans stay, as standalone.`, "Delete Organization", async () => {
      await act("detach-org", o.id);
      await Orgs.mutate(d => { d.orgs = d.orgs.filter(x => x.id !== o.id); d.items = d.items.filter(i => i.orgID !== o.id); });
      selected = Orgs.list[0]?.id || null; draw();
    });
  };
  const draw = () => { drawList(); drawDetail(); };
  $("olist").onclick = e => { const b = e.target.closest("[data-id]"); if (b) { selected = b.dataset.id; picked.clear(); draw(); } };
  $("oadd").onclick = () => act("new-org");
  // Redraw when another window changes organizations or saved scans (but not while typing in this one).
  const redraw = async () => { if (document.activeElement && ["on", "od", "ono", "ons", "odh"].includes(document.activeElement.id)) { drawList(); return; } await loadSites(); if (!Orgs.org(selected)) selected = Orgs.list[0]?.id || null; draw(); };
  Orgs.onChange(redraw);
  T.event.listen("sites-changed", redraw);
  T.event.listen("unifi-changed", async () => { await loadUnifi(); draw(); });
  draw();
  return id => { selected = id; picked.clear(); draw(); };
}

function confirmIt(title, text, action, run) {
  const m = document.createElement("div"); m.className = "backdrop";
  m.innerHTML = `<div class="modal"><h2>${esc(title)}</h2><p>${esc(text)}</p><div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="danger">${esc(action)}</button></div></div>`;
  $("modal-root").appendChild(m);
  m.querySelector("[data-no]").onclick = () => m.remove();
  m.querySelector(".danger").onclick = () => { m.remove(); run(); };
}
function ask(title, value, done) {
  const m = document.createElement("div"); m.className = "backdrop";
  m.innerHTML = `<div class="modal"><h2>${esc(title)}</h2><div class="field"><input id="askv" value="${esc(value)}"></div><div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="primary">Save</button></div></div>`;
  $("modal-root").appendChild(m);
  const i = m.querySelector("#askv"); setTimeout(() => { i.focus(); i.select(); }, 0);
  const ok = () => { m.remove(); done(i.value); };
  m.querySelector("[data-no]").onclick = () => m.remove();
  m.querySelector(".primary").onclick = ok;
  i.onkeydown = e => { if (e.key === "Enter") ok(); if (e.key === "Escape") m.remove(); };
}

/// A saved item, as it was: its table, Follow CNAMEs for DNS lookups, Download CSV / Excel.
function itemView(id) {
  const it = Orgs.item(id); if (!it) return;
  const o = Orgs.org(it.orgID);
  const m = document.createElement("div"); m.className = "backdrop";
  m.innerHTML = `<div class="modal wide" style="width:min(1100px, calc(100vw - 32px));height:calc(100vh - 60px)">
    <div class="bar"><h2 class="grow" style="margin:0">${esc(it.title)}</h2>${it.kind === "dns" ? '<label class="check"><input type="checkbox" id="ivf"> Follow CNAMEs to other domains</label>' : ""}
      <button type="button" id="ivcsv">Download CSV…</button><button type="button" id="ivxls">Download Excel (.xlsx)…</button><button type="button" class="primary" id="ivclose">Close</button></div>
    <p class="note" style="margin:0">${esc([o?.name, it.siteName && it.siteName !== o?.name ? it.siteName : "", new Date(it.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), it.summary].filter(Boolean).join(" · "))}</p>
    ${it.note ? `<p style="margin:0"><i>“${esc(it.note)}”</i></p>` : ""}<p class="note" id="ivhint" style="margin:0" hidden>This lookup was saved without where its CNAMEs lead. Look it up again in DNS Lookup to see them.</p>
    <div class="tablebox" style="flex:1" id="ivtable"><table class="tt"><thead><tr id="ivh"></tr></thead><tbody id="ivb"></tbody></table></div>
    <div class="tablebox dnsbox" style="flex:1" id="ivgroups" hidden></div></div>`;
  $("modal-root").appendChild(m);
  const q = sel => m.querySelector(sel);
  const table = () => it.kind === "dns" && !(q("#ivf")?.checked) ? { ...it.table, rows: it.table.rows.filter(r => !isChainRow(r)) } : it.table;
  const isLookUp = it.table.header.join("|") === "Name|Type|TTL|Answer";
  const folded = new Set();
  if (isLookUp) dnsFoldClicks(q("#ivgroups"), folded, () => draw());
  const draw = () => {
    const t = table();
    q("#ivtable").hidden = isLookUp; q("#ivgroups").hidden = !isLookUp;
    if (isLookUp) q("#ivgroups").innerHTML = dnsSectionsHtml(dnsSections(dnsLinesFromRows(t.rows)), folded);
    q("#ivh").innerHTML = t.header.map((h, c) => `<th class="${(t.numberColumns || []).includes(c) ? "num" : ""}">${esc(h)}</th>`).join("");
    q("#ivb").innerHTML = t.rows.map(r => `<tr>${r.map((v, c) => `<td class="${(t.numberColumns || []).includes(c) ? "num" : ""}" style="white-space:pre-line">${esc(v)}</td>`).join("")}</tr>`).join("");
    if (q("#ivhint")) q("#ivhint").hidden = !(it.kind === "dns" && q("#ivf")?.checked && !it.table.rows.some(isChainRow));
  };
  if (q("#ivf")) { q("#ivf").checked = load("dnsFollowCNAMEs", "0") === "1"; q("#ivf").onchange = () => { save("dnsFollowCNAMEs", q("#ivf").checked ? "1" : "0"); draw(); }; }
  const base = `${it.title} ${it.date.slice(0, 10)}`;
  q("#ivcsv").onclick = () => download("csv", base, table().header, table().rows).catch(() => {});
  q("#ivxls").onclick = () => download("xlsx", base, table().header, table().rows, KINDS[it.kind]?.title).catch(() => {});
  q("#ivclose").onclick = () => m.remove();
  m.addEventListener("keydown", e => { if (e.key === "Escape") m.remove(); });
  draw();
}

/// Export Organization (Excel): an Overview sheet (the organization, its scans, a list of saved items), then a sheet per item.
async function exportOrg(o) {
  let sites = [];
  try { sites = (JSON.parse(await invoke("load_data") || "{}").sites || []).filter(x => x.orgID === o.id); } catch {}
  const list = Orgs.items(o.id);
  const follow = load("dnsFollowCNAMEs", "0") === "1";
  const fmtD = iso => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const overview = [["Organization", o.name], ["Domains", o.domains.join(", ")], ["Name server", o.nameServer || ""], ["DHCP range", o.dhcpRange || ""], ["Notes", o.notes], ["Exported", fmtD(new Date().toISOString())], ["", ""],
    ...sites.map(x => [`Site: ${x.name}`, [x.range, x.nameServer ? `name server ${x.nameServer}` : ""].filter(Boolean).join(" · ")]), ["", ""],
    ["Saved", `${list.length} items (one sheet each, newest first)`], ...list.map(i => [fmtD(i.date), [i.title, i.summary, i.note].filter(Boolean).join(" · ")])];
  const stamp = iso => { const d = new Date(iso); return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`; };
  const sheets = [{ name: "Overview", header: ["ARPradar", "Organization export"], rows: overview, widths: [24, 100], numberColumns: [] },
    ...list.map(i => { const t = i.kind === "dns" && !follow ? { ...i.table, rows: i.table.rows.filter(r => !isChainRow(r)) } : i.table;
      return { name: `${KINDS[i.kind]?.title || i.kind} ${stamp(i.date)}`, header: t.header, rows: t.rows, widths: t.widths || [], numberColumns: t.numberColumns || [] }; })];
  try { await invoke("export_workbook", { fileName: `${o.name} ${new Date().toISOString().slice(0, 10)}.xlsx`.replace(/[\\/:*?"<>|]/g, "-"), sheets }); }
  catch (e) { confirmIt("Couldn’t export", String(e), "OK", () => {}); }
}

// MARK: Start

// MARK: Scan Ports (its own window per device, so the main window stays usable while it runs)

const PORT_ACTIONS = { 22: ["SSH", "ssh"], 139: ["Open Shares", "shares"], 445: ["Open Shares", "shares"], 3389: ["Remote Desktop", "rdp"], 5900: ["VNC", "vnc"], 5901: ["VNC", "vnc"] };
const WEB_PORTS = [80, 81, 443, 3000, 4443, 5000, 5001, 7443, 8000, 8008, 8080, 8081, 8088, 8123, 8443, 8843, 8880, 8888, 9000, 9090, 9443, 10000, 32400];
const portUrl = (ip, port) => `${[443, 8443, 4443, 7443, 9443, 5001, 8843].includes(port) ? "https" : "http"}://${ip}${[80, 443].includes(port) ? "" : ":" + port}`;
/// arg: JSON {ip, name, site} from the main window (or a bare IP).
async function portsTool(root, arg) {
  let d = { ip: "", name: "", site: "" };
  try { d = { ...d, ...JSON.parse(arg) }; } catch { d.ip = String(arg || "").trim(); }
  document.title = `Scan Ports · ${d.ip}`;
  let services = new Map();
  try { services = new Map(await invoke("common_ports")); } catch {}
  const id = Math.floor(Math.random() * 1e9);
  let running = false, found = [], banners = {}, checked = 0, lastTotal = 0;
  root.innerHTML = `<h2 style="margin:0">Scan ports on ${esc(d.name ? `${d.name} (${d.ip})` : d.ip)}</h2>
    <div class="radios">
      <label><input type="radio" name="pm" value="common" checked> Common ports (about ${services.size}: web, file sharing, remote access, mail, databases, printers, cameras)</label>
      <label><input type="radio" name="pm" value="all"> All ports (1–65535; under a minute on your LAN, longer over a VPN)</label>
      <label><input type="radio" name="pm" value="list"> Ports: <input type="text" id="pl" class="mono" placeholder="1-1024, 8000-8100, 5060" spellcheck="false" aria-label="Ports to check"></label>
    </div>
    <div class="bar"><button type="button" class="primary" id="pgo">Scan</button><button type="button" id="pcopy" disabled>Copy List</button><span id="psave"></span>
      <div class="ports-status grow"><div class="progress" id="pp" hidden><div id="ppb" style="height:100%;width:0;background:var(--green);transition:width .3s"></div></div><span id="pst"></span></div></div>
    <div class="tablebox"><table class="tt"><thead><tr><th>Port</th><th>Service</th><th>What answers</th><th></th></tr></thead><tbody id="prows"></tbody></table></div>
    <p class="note">You can keep using the main window while this runs. Open ports are added to the device’s details.</p>`;
  const draw = () => {
    $("prows").innerHTML = found.slice().sort((a, b) => a - b).map(p => {
      const a = PORT_ACTIONS[p] || (WEB_PORTS.includes(p) ? ["Open in Browser", "web"] : null);
      return `<tr><td class="mono">${p}</td><td>${esc(services.get(p) || "")}</td><td>${esc(banners[p] || "")}</td><td>${a ? `<button type="button" data-p="${p}">${a[0]}</button>` : ""}</td></tr>`;
    }).join("");
    $("pcopy").disabled = !found.length;
  };
  $("prows").onclick = e => {
    const b = e.target.closest("[data-p]"); if (!b) return;
    const p = Number(b.dataset.p), a = PORT_ACTIONS[p];
    invoke("open_device", a ? { kind: a[1], target: d.ip } : { kind: "web", target: portUrl(d.ip, p) }).catch(e => ($("pst").textContent = String(e)));
  };
  $("pcopy").onclick = () => { copyText(found.slice().sort((a, b) => a - b).map(p => `${p}\t${services.get(p) || ""}\t${banners[p] || ""}`).join("\n")); $("pst").textContent = `Copied ${found.length} port${found.length === 1 ? "" : "s"}`; };
  $("pl").onfocus = () => { root.querySelector('input[value="list"]').checked = true; };
  const refreshSave = saveToOrgButton($("psave"), () => Drafts.ports(d, found.slice().sort((a, b) => a - b).map(p => ({ port: p, service: services.get(p) || "", banner: banners[p] || "" })), checked),
    { enabled: () => checked > 0 && !running, siteName: () => d.site || "" });
  const setRunning = on => { running = on; busy("ports", on); $("pgo").textContent = on ? "Stop" : "Scan"; $("pgo").className = on ? "stop" : "primary"; $("pp").hidden = !on; root.querySelectorAll(".radios input").forEach(i => i.disabled = on); };
  const start = async () => {
    if (running) return invoke("port_scan_stop", { id });
    const mode = root.querySelector('input[name="pm"]:checked').value;
    found = []; banners = {}; draw();
    try {
      const n = await invoke("port_scan_start", { id, ip: d.ip, mode, list: $("pl").value });
      setRunning(true); $("pst").textContent = `Checking ${n} ports…`; $("ppb").style.width = "0";
    } catch (e) { $("pst").textContent = String(e); }
  };
  $("pgo").onclick = start;
  $("pl").onkeydown = e => { if (e.key === "Enter" && !running) start(); };
  T.event.listen("portscan", e => {
    const ev = e.payload; if (ev.id !== id) return;
    if (ev.kind === "open") { found.push(ev.port); draw(); }
    if (ev.kind === "progress") { lastTotal = ev.total; $("ppb").style.width = `${Math.round(ev.done / ev.total * 100)}%`; $("pst").textContent = `Checked ${ev.done} of ${ev.total}…`; }
    if (ev.kind === "banners") { banners = ev.banners; draw(); }
    if (ev.kind === "finished") {
      setRunning(false);
      $("pst").textContent = ev.cancelled ? `Stopped · ${found.length} open` : found.length ? `${found.length} open` : "No open ports found.";
      // The main window adds them to the device (details panel, saved copies).
      if (!ev.cancelled) { try { T.event.emit?.("portscan-done", { ip: d.ip, open: found, banners })?.catch(() => {}); } catch {} }
      checked = ev.cancelled ? checked : (lastTotal || checked); refreshSave();
    }
  });
  window.addEventListener("beforeunload", () => { if (running) invoke("port_scan_stop", { id }).catch(() => {}); });
  if (d.autoStart) start();
}

const TOOLS = { heatmap: heatmapTool, ports: portsTool, help: helpTool, orgs: orgsTool, settings: settingsTool, remotewake: remoteWakeTool, ping: pingTool, trace: traceTool, dns: dnsTool, wifi: wifiTool, analyzer: analyzerTool, connection: connectionTool, speed: speedTool, subnet: subnetTool };
document.body.classList.toggle("basic", !advanced());
window.addEventListener("storage", e => { if (e.key === "mode") document.body.classList.toggle("basic", !advanced()); });
(async () => {
  await Orgs.load();
  const which = window.__TOOL__ || { tool: new URLSearchParams(location.search).get("tool") || "ping", arg: new URLSearchParams(location.search).get("arg") };
  window.autoSaveOrg = which.tool === "orgs" ? null : OrgLaunch.take();
  const setArg = await (TOOLS[which.tool] || pingTool)($("tool"), which.arg || "");
  // Right-click › Ping (etc.) on a device while this window is already open: fill it in.
  if (typeof setArg === "function") T.event.listen("tool-arg", e => { const o = OrgLaunch.take(); if (o) window.autoSaveOrg = o; setArg(e.payload); });
})();
