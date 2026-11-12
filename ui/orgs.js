// Organizations and everything saved for them (organizations.json), shared by every ARPradar window.
// Same model as the Mac app's Organizations.swift: an organization has a name, domains and notes; saved scans point at
// it (site.orgID); saved items are tables of results (a scan, a DNS lookup, a speed test, a site survey...).
"use strict";

/// One CSV cell, quoted when it needs to be. A cell that starts like a formula (=, +, -, @, tab, return) gets a
/// leading apostrophe so Excel shows it as text instead of running it: device names, web page titles and SNMP strings
/// come straight off the network and could say anything. Same as the Mac's Exporter.csvCell.
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}
/// CSV text (Windows line ends) for a header and rows.
const csvText = (header, rows) => [header, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
/// One cell of tab-separated text for the clipboard: tabs and line breaks inside it become spaces.
const tsvCell = v => String(v ?? "").replace(/[\t\r\n]+/g, " ");

/// The Site Surveys tab: each survey (newest first), followed by its results (oldest first) when it's open.
function surveyRows(list, expanded) {
  const out = [];
  for (const s of list.filter(i => i.kind === "survey").sort((a, b) => b.date.localeCompare(a.date))) {
    out.push({ item: s, indented: false });
    if (!expanded.has(s.id) || !s.surveyID) continue;
    for (const c of list.filter(i => i.surveyID === s.surveyID && i.kind !== "survey").sort((a, b) => a.date.localeCompare(b.date))) out.push({ item: c, indented: true });
  }
  return out;
}
/// How many results a survey filed.
const surveyResultCount = (survey, list) => survey.surveyID ? list.filter(i => i.surveyID === survey.surveyID && i.kind !== "survey").length : 0;
/// The DNS tab's Expiry side: domain and certificate expiry checks (the rest of DNS is Lookups).
const isExpiryCheck = i => i.kind === "dns" && String(i.title || "").startsWith("Domain and certificate expiry");

/// An organization's entry for a Wi-Fi heatmap: by its link, else (saved before heatmaps were linked) by its title.
/// Index in `list`, or -1. Saving the heatmap again updates that entry instead of adding another.
function heatmapEntry(heatmap, title, org, list) {
  const i = list.findIndex(x => x.orgID === org && x.kind === "heatmap" && x.heatmapID === heatmap);
  return i >= 0 ? i : list.findIndex(x => x.orgID === org && x.kind === "heatmap" && !x.heatmapID && x.title === title);
}

const Orgs = (() => {
  const T = () => window.__TAURI__;
  const me = Math.random().toString(36).slice(2);
  let data = { orgs: [], items: [] };
  const listeners = new Set();
  const id = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).toUpperCase();

  // Set when organizations.json is there but couldn't be read; saving is then refused so the file stays as it is.
  let problem = null;
  async function load() {
    let text;
    try { text = await T().core.invoke("load_file", { name: "organizations" }); }
    catch (e) { problem = problem || `ARPradar couldn’t read its organizations file: ${e}. Nothing will be saved there until the app is reopened.`; }
    if (text) {
      try {
        const d = JSON.parse(text);
        data = { orgs: Array.isArray(d.orgs) ? d.orgs : [], items: Array.isArray(d.items) ? d.items : [] };
      } catch {
        if (!problem) {
          const copy = await T().core.invoke("keep_unreadable_data", { name: "organizations" }).catch(() => "organizations.unreadable.json");
          problem = `ARPradar couldn’t make sense of its organizations file; a copy was kept at ${copy}. Nothing will be saved there until the app is reopened.`;
        }
      }
    }
    listeners.forEach(f => f());
    return data;
  }

  // Every change reads the file fresh, changes it, writes it back and tells the other windows, so two windows
  // saving at nearly the same time don't undo each other.
  let queue = Promise.resolve();
  function mutate(fn) {
    const run = queue.then(async () => {
      await load();
      if (problem) throw new Error(problem);
      const result = fn(data);
      await T().core.invoke("save_file", { name: "organizations", json: JSON.stringify(data) });
      try { T().event.emit?.("orgs-changed", { from: me })?.catch(() => {}); } catch {}
      listeners.forEach(f => f());
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }
  try { T()?.event?.listen("orgs-changed", e => { if (e.payload?.from !== me) load(); }); } catch {}

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  function uniqueName(base, list = data.orgs) {
    const taken = new Set(list.map(o => o.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }
  /// Inside mutate: the organization with this name (any case), made if there isn't one.
  function ensureIn(d, name) {
    const o = d.orgs.find(x => x.name.toLowerCase() === name.trim().toLowerCase());
    if (o) return o.id;
    const n = { id: id(), name: name.trim(), domains: [], nameServer: "", dhcpRange: "", notes: "", created: new Date().toISOString() };
    d.orgs.push(n);
    return n.id;
  }
  const parseDomains = text => text.split(/[\s,;]+/).map(s => s.replace(/^\.+|\.+$/g, "").toLowerCase()).filter(Boolean);

  /// Newest first, with each survey's results right under the survey (oldest first), indented.
  function timeline(list) {
    const surveys = new Set(list.filter(i => i.kind === "survey" && i.surveyID).map(i => i.surveyID));
    const out = [];
    for (const i of [...list].sort((a, b) => b.date.localeCompare(a.date))) {
      if (i.surveyID && surveys.has(i.surveyID) && i.kind !== "survey") continue;
      out.push({ item: i, indented: false });
      if (i.kind === "survey" && i.surveyID)
        for (const c of list.filter(x => x.surveyID === i.surveyID && x.kind !== "survey").sort((a, b) => a.date.localeCompare(b.date))) out.push({ item: c, indented: true });
    }
    return out;
  }

  function addItem(orgID, draft, extra = {}) {
    return mutate(d => {
      // A heatmap saved here before is updated in place (measured some more, renamed), not added twice.
      const i = draft.heatmapID ? heatmapEntry(draft.heatmapID, draft.title, orgID, d.items) : -1;
      if (i >= 0) {
        Object.assign(d.items[i], { title: draft.title, summary: draft.summary, table: draft.table, date: new Date().toISOString(), heatmapID: draft.heatmapID });
        if (extra.note) d.items[i].note = extra.note;
        return;
      }
      d.items.push({ ...(draft.heatmapID ? { heatmapID: draft.heatmapID } : {}), id: id(), orgID, kind: draft.kind, date: new Date().toISOString(), title: draft.title, summary: draft.summary,
                     note: extra.note || "", siteName: extra.siteName || "", surveyID: extra.surveyID || null, table: draft.table });
    });
  }

  return {
    load, mutate, onChange: f => listeners.add(f), newId: id, uniqueName, ensureIn, parseDomains, timeline, addItem,
    get list() { return [...data.orgs].sort(byName); },
    /// Why organizations.json is read-only this session (it couldn't be read), or null.
    get problem() { return problem; },
    org: oid => data.orgs.find(o => o.id === oid) || null,
    items: oid => data.items.filter(i => i.orgID === oid).sort((a, b) => b.date.localeCompare(a.date)),
    item: iid => data.items.find(i => i.id === iid) || null,
  };
})();

// MARK: Saved item kinds and turning each tool's results into a table (the Mac's OrgDrafts.swift)

const KINDS = {
  survey: { title: "Site survey", group: "surveys" }, networkScan: { title: "Network scan", group: "scans" },
  dns: { title: "DNS lookup", group: "dns" }, portScan: { title: "Scan Ports", group: "ports" },
  traceroute: { title: "Traceroute", group: "other" }, ping: { title: "Ping", group: "other" },
  speedTest: { title: "Speed test", group: "other" }, wifi: { title: "Wi-Fi survey", group: "other" },
  wifiSignal: { title: "Wi-Fi signal", group: "other" }, connection: { title: "Connection info", group: "other" },
  heatmap: { title: "Wi-Fi heatmap", group: "heatmaps" },
};
const n1 = v => v == null || Number.isNaN(v) ? "" : v.toFixed(1);
const isChainRow = r => /^\s*↳/.test(r[0] || "");

const Drafts = {
  /// rows: [{name, type, ttl, data, depth}] in the order shown (depth > 0 = followed through a CNAME).
  dns(target, type, server, rows) {
    if (!rows.length) return null;
    const own = rows.filter(a => !a.depth).length;
    return { kind: "dns", title: `DNS lookup · ${target} (${type})`, summary: `${own} records` + (server ? ` from ${server}` : ""),
      table: { header: ["Name", "Type", "TTL", "Answer"], rows: rows.map(a => [a.depth ? "  ".repeat(a.depth - 1) + "↳ " + a.name : a.name, a.type, String(a.ttl), a.data]),
               widths: [48, 8, 8, 70], numberColumns: [2] } };
  },
  ports(d, results, checked) {
    if (!checked) return null;
    const who = d.name ? `${d.name} (${d.ip})` : d.ip;
    return { kind: "portScan", title: `Scan Ports · ${who}`, summary: `${results.length} open of ${checked} checked`,
      table: { header: ["Port", "Service", "What answers"], rows: results.map(r => [String(r.port), r.service, r.banner]), widths: [8, 28, 50], numberColumns: [0] } };
  },
  traceroute(target, hops) {
    if (!hops.length) return null;
    const last = hops.at(-1)?.ms;
    return { kind: "traceroute", title: `Traceroute · ${target}`, summary: `${hops.length} hops${last != null ? `, ${Math.round(last)} ms to the end` : ""}`,
      table: { header: ["Hop", "Address", "Name", "Time (ms)"], rows: hops.map(h => [String(h.number), h.address, h.address === "*" ? "no answer" : h.name, n1(h.ms)]),
               widths: [6, 18, 44, 10], numberColumns: [0] } };
  },
  /// list: [{target, sent, lost, avg, min, max, jitter}]
  ping(list) {
    list = list.filter(s => s.sent > 0);
    if (!list.length) return null;
    const sent = list.reduce((a, s) => a + s.sent, 0), lost = list.reduce((a, s) => a + s.lost, 0);
    return { kind: "ping", title: `Ping · ${list.map(s => s.target).join(", ")}`,
      summary: `${sent} sent, ${lost} lost, avg ${list.filter(s => s.avg != null).map(s => Math.round(s.avg) + " ms").join(" / ")}`,
      table: { header: ["Target", "Sent", "Lost", "Avg ms", "Min ms", "Max ms", "Jitter ms"],
               rows: list.map(s => [s.target, String(s.sent), String(s.lost), n1(s.avg), n1(s.min), n1(s.max), n1(s.jitter)]),
               widths: [24, 7, 7, 9, 9, 9, 10], numberColumns: [1, 2] } };
  },
  speed(r, site) {
    return { kind: "speedTest", title: "Speed test" + (site ? ` · ${site}` : ""),
      summary: `${Math.round(r.down)} down / ${Math.round(r.up)} up Mb/s · latency ${Math.round(r.idle)} ms idle, ${Math.round(r.loaded)} ms busy`,
      table: { header: ["Measure", "Value"], rows: [["Download", `${n1(r.down)} Mb/s`], ["Upload", `${n1(r.up)} Mb/s`], ["Idle latency", `${Math.round(r.idle)} ms`],
               ["Busy latency", `${Math.round(r.loaded)} ms`], ["Server", "Cloudflare"], ["When", new Date(r.date || Date.now()).toLocaleString()]], widths: [20, 40] } };
  },
  /// signal: [[label, value]] for this PC's connection; nets: Wi-Fi Analyzer networks.
  wifiNetworks(nets, signal) {
    if (!nets.length && !signal.length) return null;
    const mine = (signal.find(r => r[0] === "Signal") || [])[1] || "";
    const rows = [...nets].sort((a, b) => a.band.localeCompare(b.band) || b.rssi - a.rssi)
      .map(n => [n.ssid || "(name hidden)", String(n.rssi), String(n.channel), n.band, String(n.widthMhz), n.security, n.bssid, n.mine ? "yes" : ""]);
    return { kind: "wifi", title: "Wi-Fi survey", summary: `${nets.length} networks nearby` + (mine ? ` · this PC ${mine}` : ""),
      table: { header: ["Network", "Signal dBm", "Channel", "Band", "Width MHz", "Security", "Access point", "Connected"],
               rows: [...signal.map(r => [`This PC: ${r[0]}`, r[1], "", "", "", "", "", ""]), ...rows], widths: [28, 11, 9, 9, 10, 22, 20, 10], numberColumns: [1, 2, 4] } };
  },
  wifiSignal(rows) {
    if (!rows.length) return null;
    return { kind: "wifiSignal", title: "Wi-Fi signal", summary: (rows.find(r => r[0] === "Signal") || [])[1] || "",
      table: { header: ["", "Value"], rows: rows.map(r => [r[0], r[1]]), widths: [18, 60] } };
  },
  /// rows: [item, expires, issuer, details] from expiryRows().
  expiry(domain, rows) {
    if (!rows.length) return null;
    return { kind: "dns", title: `Domain and certificate expiry · ${domain}`, summary: rows.map(r => `${r[0].replace(/\..*$/, "")}: ${r[1].replace(/ \(.*/, "")}`).slice(0, 3).join(" · "),
      table: { header: ["", "Expires", "Issued by / registrar", "Details"], rows, widths: [32, 24, 26, 60] } };
  },
  connection(rows, adapter) {
    if (!rows.length) return null;
    const v = k => (rows.find(r => r[0] === k) || [])[1] || "";
    return { kind: "connection", title: `Connection info · ${adapter}`,
      summary: [`IP ${v("IP address")}`, v("DHCP server") && `DHCP ${v("DHCP server")}`, v("Public IP") && `public ${v("Public IP")}`].filter(Boolean).join(" · "),
      table: { header: ["", "Value"], rows: rows.filter(r => r[1]).map(r => [r[0], r[1]]), widths: [18, 70] } };
  },
};

/// Connection Info as label/value rows (also used by the survey).
function connectionRows(info, publicIp) {
  if (!info) return [];
  const lease = info.leaseLeftSecs != null ? (() => { const d = new Date(Date.now() + info.leaseLeftSecs * 1000);
    return `ends ${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${info.leaseLeftSecs >= 3600 ? Math.round(info.leaseLeftSecs / 3600) + " h" : Math.round(info.leaseLeftSecs / 60) + " min"} left)`; })() : "";
  const rows = [["Adapter", info.adapter], ["IP address", `${info.address} /${info.prefix}`], ["Subnet mask", info.mask], ["Router", info.router],
    ["DHCP", info.dhcp ? "On" : "Off (fixed address)"], ["DHCP server", info.dhcpServer], ["Lease", lease], ["DNS servers", info.dns.join(", ")],
    ["DNS suffix", info.domain], ["IPv6", info.ipv6.join("\n")], ["MAC", info.mac], ["MTU", info.mtu ? String(info.mtu) : ""], ["Link speed", info.linkMbps ? `${info.linkMbps} Mbps` : ""]];
  if (publicIp) rows.push(["Public IP", publicIp]);
  return rows;
}

/// Wi-Fi Signal as label/value rows.
function wifiRows(s) {
  if (!s || (s.state !== "ok" && s.state !== "location")) return [];
  return [["Signal", `${s.rssi} dBm`], ["Quality", `${s.quality}%`], ["Speed", `${Math.round(s.rxMbps)} / ${Math.round(s.txMbps)} Mb/s (receive / send)`],
    ["Network", s.ssid || "(hidden by Windows)"], ["Access point", s.bssid || "(hidden by Windows)"],
    ["Channel", s.channel ? `${s.channel}${s.band ? " · " + s.band : ""}${s.widthMhz ? " · " + s.widthMhz + " MHz" : ""}` : ""], ["Security", s.security]].filter(r => r[1]);
}

// MARK: Started from an organization's page (the Mac's OrgAutoSaveScope)

/// The organization page marks the tool window it opens; that window files each finished run there, with no prompt.
const OrgLaunch = {
  mark(orgId) { try { localStorage.setItem("orgLaunch", JSON.stringify({ id: orgId, at: Date.now() })); } catch {} },
  /// The organization a window was just opened from (within 5 seconds), once.
  take() {
    try { const x = JSON.parse(localStorage.getItem("orgLaunch") || "null"); localStorage.removeItem("orgLaunch"); return x && Date.now() - x.at < 5000 ? x.id : null; }
    catch { return null; }
  },
};

// MARK: "Save to Organization" (Advanced mode, like the Mac): a button with a menu of organizations, then a note.
// With an organization to save to automatically (opts.autoOrg, or window.autoSaveOrg in a tool window opened from an
// organization's page), it reads "Saves to X" and files each finished run there; opts.auto false keeps it manual
// (Ping and Wi-Fi keep running, so they never finish).

function saveToOrgButton(holder, makeDraft, opts = {}) {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "advanced-only"; btn.textContent = "Save to Organization ▾";
  btn.title = "File these results under an organization, to look back at later";
  holder.appendChild(btn);
  let lastSig, filing = false;
  const autoOrg = () => {
    if (opts.auto === false) return null;
    const oid = (typeof opts.autoOrg === "function" ? opts.autoOrg() : opts.autoOrg) || window.autoSaveOrg || "";
    return oid ? Orgs.org(oid) : null;
  };
  const refresh = () => {
    const on = opts.enabled ? !!opts.enabled() : true;
    btn.disabled = !on;
    const o = autoOrg();
    if (!o) { if (btn.dataset.auto) { delete btn.dataset.auto; btn.textContent = "Save to Organization ▾"; } return; }
    btn.dataset.auto = "1";
    let draft = null;
    if (on) { try { draft = makeDraft(); } catch {} }
    const sig = draft ? JSON.stringify([draft.title, draft.summary, draft.table]) : null;
    if (lastSig === undefined) lastSig = sig;   // results already there when it opened aren't filed
    if (sig && sig !== lastSig && !filing) {
      lastSig = sig; filing = true;
      Orgs.addItem(o.id, draft, { siteName: opts.siteName?.() || "" })
        .then(() => { btn.textContent = `Saved to ${o.name} ✓`; }).finally(() => { filing = false; });
    } else if (!on || !btn.textContent.startsWith("Saved to")) btn.textContent = `Saves to ${o.name}`;
    btn.title = `Started from ${o.name}: each finished run is saved there`;
  };
  refresh();
  const timer = setInterval(() => (btn.isConnected ? refresh() : clearInterval(timer)), 1000);
  btn.addEventListener("click", async e => {
    e.stopPropagation();
    await Orgs.load();
    const menu = document.createElement("div");
    menu.className = "menu"; menu.setAttribute("role", "menu");
    const cur = Orgs.org(localStorage.getItem("currentOrgId") || "");
    menu.innerHTML = (cur ? `<button type="button" data-o="${esc(cur.id)}">${esc(cur.name)} (current scan)</button><hr>` : "")
      + Orgs.list.map(o => `<button type="button" data-o="${esc(o.id)}">${esc(o.name)}</button>`).join("")
      + (Orgs.list.length ? "<hr>" : "") + `<button type="button" data-new>New Organization…</button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(r.bottom + 2, innerHeight - menu.offsetHeight - 8)}px`;
    const close = () => { menu.remove(); document.removeEventListener("click", close); };
    setTimeout(() => document.addEventListener("click", close), 0);
    menu.onclick = ev => {
      const b = ev.target.closest("button"); if (!b) return;
      close();
      if (b.dataset.new !== undefined) { window.__TAURI__.core.invoke("org_action", { action: "new-org", value: "" }).catch(() => {}); return; }
      const draft = makeDraft();
      if (!draft) return;
      const org = Orgs.org(b.dataset.o);
      const back = document.createElement("div");
      back.className = "backdrop";
      back.innerHTML = `<div class="modal"><h2>Save to ${esc(org.name)}</h2><p>${esc(draft.title)} · ${esc(draft.summary)}</p>
        <div class="field"><label for="stn">Note (optional)</label><input id="stn"></div>
        <div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="primary">Save</button></div></div>`;
      (document.getElementById("modal-root") || document.body).appendChild(back);
      const input = back.querySelector("#stn");
      setTimeout(() => input.focus(), 0);
      const save = async () => {
        back.remove();
        await Orgs.addItem(org.id, draft, { note: input.value.trim(), siteName: opts.siteName?.() || localStorage.getItem("currentSiteName") || "" });
        opts.onSaved?.(org.id);
        btn.textContent = "Saved ✓";
        setTimeout(() => (btn.textContent = "Save to Organization ▾"), 2000);
      };
      back.querySelector("[data-no]").onclick = () => back.remove();
      back.querySelector(".primary").onclick = save;
      input.onkeydown = k => { if (k.key === "Enter") save(); if (k.key === "Escape") back.remove(); };
    };
  });
  return refresh;
}
