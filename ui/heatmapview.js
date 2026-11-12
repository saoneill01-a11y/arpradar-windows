// Tools › Wi-Fi Heatmap (same as the Mac's Heatmap/HeatmapView.swift and HeatmapOverlay.swift): load a floor plan,
// click where you're standing to measure, then see the map. The math is in heatmap.js; files go through the Rust
// heatmap_* commands (<app data>/heatmaps/<id>/). Runs in tool.html (tools.js gives $, esc, invoke, load, save…).
"use strict";

/// Spots are measured with this many Wi-Fi scans, a little apart (Windows' list refreshes a few seconds after a scan).
const HEAT_SCANS = 3, HEAT_SCAN_GAP_MS = 2500, HEAT_MAX_ZOOM = 8;
const HEAT_FILE_TYPES = "image/png,image/jpeg,image/gif,image/bmp,image/webp,application/pdf,.pdf";

async function heatmapTool(root, arg) {
  document.title = "Wi-Fi Heatmap";
  document.body.classList.add("heatwin");
  const st = {
    surveys: [], tab: "walk", mode: "signal", band: "all", apKey: null, hoveredAP: null, selected: null, infoSpot: null, infoAP: null,
    zoom: 1, scaling: false, scalePoints: [], busy: null, problem: null, heat: null, plans: new Map(), drag: null,
    highlight: load("heatmap.highlightChannels", "0") === "1", clashBand: load("heatmap.clashBand", "5 GHz"),
    planOpacity: Number(load("heatmap.planOpacity", "1")), ping: load("heatmap.ping", "0") === "1", uniFi: null,
  };
  const current = () => st.surveys.find(s => s.id === load("heatmap.current", "")) || st.surveys[0] || null;
  const setCurrent = id => { save("heatmap.current", id || ""); st.zoom = 1; st.selected = st.infoSpot = st.infoAP = null; st.apKey = null; };
  const dBm = v => String(v).replace("-", "−");
  const signalClass = r => r >= -67 ? "good" : r >= -75 ? "fair" : "poor";
  const filterFor = s => {
    const radios = st.mode === "oneAP" && s ? new Set(Object.entries(Heatmap.cachedGroups(s)).filter(([, k]) => k === st.apKey).map(([b]) => b)) : new Set();
    return { ssid: s ? Heatmap.shownNetwork(s) : null, band: st.band, bssid: st.mode === "oneAP" ? st.apKey : null, radios };
  };
  const channelView = () => st.tab === "map" && st.highlight;

  // MARK: Storage

  async function loadAll() {
    const list = await invoke("heatmap_list").catch(() => []);
    st.surveys = list.map(t => { try { return Heatmap.normalize(JSON.parse(t)); } catch { return null; } }).filter(Boolean)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }
  async function write(s) { await invoke("heatmap_save", { id: s.id, json: JSON.stringify(s) }); }
  /// Changes a heatmap, saves it and redraws.
  async function update(id, change) {
    const s = st.surveys.find(x => x.id === id); if (!s) return;
    change(s);
    render();
    try { await write(s); } catch (e) { problem(String(e)); }
  }
  const uniqueName = base => { const names = new Set(st.surveys.map(s => s.name)); if (!names.has(base)) return base; let n = 2; while (names.has(`${base} ${n}`)) n++; return `${base} ${n}`; };
  async function create(name) {
    const s = Heatmap.newSurvey(uniqueName(name));
    st.surveys.unshift(s); await write(s); setCurrent(s.id); st.tab = "walk"; render();
  }
  /// The plan picture as a data: URL (cached), or null for the blank grid.
  async function planURL(s) {
    if (!s.planFile) return null;
    const key = `${s.id}|${s.planFile}|${s.planVersion || 0}`;
    if (st.plans.has(key)) return st.plans.get(key);
    const b64 = await invoke("heatmap_read_file", { id: s.id, name: s.planFile }).catch(() => null);
    const url = b64 ? `data:image/png;base64,${b64}` : null;
    st.plans.set(key, url);
    return url;
  }
  const readPicture = async (s, name) => { const b = await invoke("heatmap_read_file", { id: s.id, name }).catch(() => null); return b ? `data:image/png;base64,${b}` : null; };
  const writePicture = (s, name, dataURL) => invoke("heatmap_write_file", { id: s.id, name, data: dataURL ? dataURL.split(",")[1] : "" });

  // MARK: Pictures (canvas)

  const loadImage = src => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("That file isn’t a picture or PDF ARPradar can read.")); i.src = src; });
  /// A picture or PDF (first page) as a PNG at most 3000 px on its longest side, on white (PDFs drawn 3000 px across).
  async function filePNG(file) {
    let source, w, h;
    if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) {
      const pdfjs = await import("./vendor/pdfjs/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const page = await doc.getPage(1);
      const v1 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 3000 / Math.max(v1.width, v1.height) });
      source = document.createElement("canvas");
      source.width = Math.round(viewport.width); source.height = Math.round(viewport.height);
      const g = source.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, source.width, source.height);
      await page.render({ canvasContext: g, viewport }).promise;
      w = source.width; h = source.height;
    } else {
      const url = URL.createObjectURL(file);
      try { source = await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
      w = source.naturalWidth; h = source.naturalHeight;
    }
    if (!(w >= 1 && h >= 1)) throw new Error("That file isn’t a picture or PDF ARPradar can read.");
    const f = Math.min(1, 3000 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * f); c.height = Math.round(h * f);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = "high"; g.drawImage(source, 0, 0, c.width, c.height);
    return { url: c.toDataURL("image/png"), width: c.width, height: c.height };
  }
  const pickFile = message => new Promise(ok => {
    const i = document.createElement("input"); i.type = "file"; i.accept = HEAT_FILE_TYPES; i.title = message;
    i.onchange = () => ok(i.files[0] || null); i.click();
  });

  /// Uses a picture or PDF as the floor plan. Spots already measured keep their place on it.
  async function setPlan(s, png) {
    await writePicture(s, "plan.png", png.url);
    await update(s.id, x => { Heatmap.rescale(x, png.width, png.height); x.planFile = "plan.png"; x.planVersion = Date.now(); });
  }
  /// Keeps the current picture as base.png too (the map a floor plan can be laid over); drops an old overlay.
  async function keepPlanAsBase(s) {
    await invoke("heatmap_copy_file", { id: s.id, from: "plan.png", to: "base.png" });
    await update(s.id, x => { x.baseFile = "base.png"; x.overlay = null; });
  }

  // MARK: Measuring

  async function routerIP() {
    try {
      const list = await invoke("list_adapters");
      const a = list.find(x => /wi-?fi|wireless|wlan/i.test(x.displayName)) || list.find(x => x.isDefault) || list[0];
      return a ? (await invoke("connection_info", { id: a.id }))?.router || null : null;
    } catch { return null; }
  }
  async function measure(p) {
    const s = current(); if (!s || st.busy) return;
    st.problem = null; st.busy = { x: p.x, y: p.y, scan: 1, heard: 0 }; render(); busy("heatmap", true);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      // The first call asks Windows for a fresh scan; each later one reads it (and asks for the next).
      await invoke("wifi_scan");
      const scans = [];
      for (let n = 1; n <= HEAT_SCANS; n++) {
        st.busy = { ...st.busy, scan: n, heard: new Set(scans.flat().map(x => x.bssid)).size }; drawStage();
        await sleep(HEAT_SCAN_GAP_MS);
        scans.push(await invoke("wifi_scan"));
      }
      const joined = await invoke("wifi_status").catch(() => ({}));
      const spot = { id: Heatmap.newId(), x: p.x, y: p.y, date: new Date().toISOString(), readings: Heatmap.average(scans),
        joinedSSID: joined.ssid || "", joinedBSSID: (joined.bssid || "").toUpperCase(), pingMs: null };
      if (st.ping) {
        const router = await routerIP();
        if (router) {
          const times = [];
          for (let i = 0; i < 3; i++) { const r = await invoke("ping_round", { ips: [router], timeoutMs: 1000 }).catch(() => ({})); if (r[router] != null) times.push(r[router]); }
          if (times.length) spot.pingMs = times.reduce((a, b) => a + b, 0) / times.length;
        }
      }
      await update(s.id, x => x.spots.push(spot));
      st.selected = spot.id;
    } catch (e) {
      st.problem = String(e) === "location" ? "location" : String(e);
    } finally { st.busy = null; busy("heatmap", false); render(); }
  }

  // MARK: The heat (worked out when the heatmap, mode or filter changes)

  let heatKey = "";
  function recompute(s) {
    const f = filterFor(s);
    const key = JSON.stringify([s.id, s.spots.length, s.spots.map(p => [p.x, p.y]).flat().join(","), s.planWidth, s.planHeight, s.scale, s.apPlaces, s.apOverrides, s.network, st.mode, f.band, f.bssid, f.ssid]);
    if (key === heatKey && st.heat) return st.heat;
    heatKey = key;
    const g = Heatmap.grid(s, st.mode, f);
    // Findings are about the whole network; the Coverage box follows the map (one AP alone when that's shown).
    const best = st.mode === "signal" ? g : Heatmap.grid(s, "signal", f);
    const aps = Heatmap.accessPoints(s.spots, { ssid: f.ssid, band: f.band }, s.apPlaces, s.apOverrides);
    st.heat = { grid: g, coverage: Heatmap.coverage(Heatmap.isSignal(st.mode) ? g : best), aps, findings: Heatmap.findings(s, f, Heatmap.coverage(best)) };
    nameFromUniFi(s, aps);
    return st.heat;
  }
  /// Access points the UniFi map knows (the latest scan with a map) get their UniFi names, kept with the heatmap.
  function nameFromUniFi(s, aps) {
    if (!st.uniFi) return;
    const uni = Heatmap.uniFiNames(st.uniFi, Heatmap.cachedGroups(s));
    const fresh = aps.filter(ap => uni[ap.key] && !s.apNames[ap.key] && !s.apNames[ap.bssid]).map(ap => [ap.key, uni[ap.key]]);
    if (fresh.length) setTimeout(() => update(s.id, x => { for (const [k, n] of fresh) x.apNames[k] = n; }), 0);
  }
  function heatCanvas(g) {
    const c = document.createElement("canvas"); c.width = g.cols; c.height = g.rows;
    const ctx = c.getContext("2d"), img = ctx.createImageData(g.cols, g.rows);
    for (let i = 0; i < g.cols * g.rows; i++) {
      const v = g.values[i]; if (v == null) continue;
      const col = Heatmap.color(Heatmap.level(v, st.mode));
      img.data[i * 4] = col[0] * 255; img.data[i * 4 + 1] = col[1] * 255; img.data[i * 4 + 2] = col[2] * 255; img.data[i * 4 + 3] = g.alpha[i] * 0.62 * 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // MARK: Window

  root.innerHTML = `<div class="hm-top" id="hmtop"></div><div class="hm-body"><div class="hm-main"><div id="hmbanner"></div>
      <div class="hm-scroll" id="hmscroll"><div class="hm-stage" id="hmstage"></div></div><div class="hm-card" id="hmcard" hidden></div>
      <div class="hm-legend" id="hmlegend"></div></div><aside class="hm-side" id="hmside"></aside></div>`;

  function render() {
    const s = current();
    renderTop(s);
    if (!s) {
      $("hmside").hidden = true; $("hmlegend").innerHTML = ""; $("hmbanner").innerHTML = ""; $("hmcard").hidden = true;
      $("hmstage").innerHTML = `<div class="hm-empty"><div class="hm-emptyicon">▦</div><h2>Wi-Fi Heatmap</h2>
        <p>Load a floor plan, walk the building with this PC and click where you’re standing. ARPradar measures every network it hears there and colors the map.</p>
        <button type="button" class="btn primary" data-hm="new">New Heatmap…</button></div>`;
      $("hmstage").style.width = $("hmstage").style.height = "100%";
      return;
    }
    $("hmside").hidden = false;
    recompute(s);
    renderBanner(s); drawStage(); renderCard(s); renderLegend(s); renderSide(s);
  }

  // Toolbar
  function renderTop(s) {
    const org = s ? Orgs.org(s.orgID) : null;
    $("hmtop").innerHTML = `<button type="button" class="hm-picker" data-hm="pick">${esc(s?.name || "No heatmap")} ▾</button>
      ${s ? `<span class="note" title="Heatmaps save themselves as you measure. Save to Organization files it with an organization; saving again updates that entry.">${esc(org ? `in ${org.name}` : "standalone")}</span>
        <button type="button" data-hm="plan" title="A picture or PDF of the building, or a map picture">Floor Plan ▾</button>
        <button type="button" data-hm="scale">${st.scaling ? "Cancel Scale" : "Set Scale"}</button>
        <div class="segmented" role="group" aria-label="Walk or Map"><button type="button" data-hm="walk" class="${st.tab === "walk" ? "on" : ""}">Walk</button><button type="button" data-hm="map" class="${st.tab === "map" ? "on" : ""}">Map</button></div>` : ""}
      <span class="grow"></span>
      ${s && st.tab === "walk" ? `<button type="button" data-hm="undo" ${!s.spots.length || st.busy ? "disabled" : ""}>Undo Last Spot</button>
        <button type="button" class="primary" data-hm="done" ${s.spots.length ? "" : "disabled"}>Done Walking</button>` : ""}
      ${s && st.tab === "map" ? `<button type="button" data-hm="export" ${s.spots.length ? "" : "disabled"}>Export PNG…</button>
        ${org ? `<button type="button" data-hm="update" ${s.spots.length ? "" : "disabled"} title="Saves the spots measured since, over the entry already in ${esc(org.name)}">Update in ${esc(org.name)}</button>` : ""}
        <span id="hmsave"></span>` : ""}`;
    if (s && st.tab === "map") {
      saveToOrgButton($("hmsave"), () => Heatmap.draft(s, filterFor(s), st.heat?.coverage || { measured: false }),
        { enabled: () => s.spots.length > 0, auto: false, onSaved: orgId => update(s.id, x => { x.orgID = orgId; }) });
    }
  }

  function renderBanner(s) {
    let html = "";
    if (st.scaling) html = note(st.scalePoints.length ? "Now click the other end." : "Click one end of a wall or doorway you know the length of.");
    else if (st.tab === "walk") {
      if (st.problem === "location") html = LOCATION_NOTE;
      else if (st.problem) html = note(st.problem, true);
      else html = note("Click the plan where you’re standing, then hold still for about 8 seconds. Every 10–15 ft is plenty.");
    }
    $("hmbanner").innerHTML = html;
    if ($("locset")) $("locset").onclick = () => invoke("open_location_settings").catch(() => {});
  }
  const note = (text, warn) => `<div class="hm-note${warn ? " warn" : ""}">${esc(text)}</div>`;

  // The plan, the heat, the spots and the access points.
  function viewport() { const sc = $("hmscroll"); return { width: sc.clientWidth, height: sc.clientHeight }; }
  function geometry(s) { return Heatmap.layout({ width: s.planWidth, height: s.planHeight }, viewport(), st.zoom); }
  async function drawStage() {
    const s = current(); if (!s) return;
    const L = geometry(s), k = L.k, ox = L.origin.x, oy = L.origin.y;
    const V = (x, y) => [ox + x * k, oy + y * k];
    const stage = $("hmstage");
    stage.style.width = `${L.size.width}px`; stage.style.height = `${L.size.height}px`;
    const plan = await planURL(s);
    if (current() !== s) return;
    const pw = s.planWidth * k, ph = s.planHeight * k, box = `left:${ox}px;top:${oy}px;width:${pw}px;height:${ph}px`;
    const heat = st.heat, aps = (heat?.aps || []).filter(a => a.worthShowing);
    const clashes = st.highlight ? Heatmap.channelClashes(aps, s.spots).filter(c => c.band === st.clashBand) : [];
    const planOp = st.tab === "map" && !channelView() ? st.planOpacity : 1;
    let html = plan ? `<img class="hm-plan" src="${plan}" style="${box};opacity:${planOp}" alt="" draggable="false">`
      : `<div class="hm-grid" style="${box};background-size:${pw / 32}px ${pw / 32}px">${!s.spots.length ? '<span>No floor plan yet: use Floor Plan (a picture or PDF), or just measure on the grid.</span>' : ""}</div>`;
    if (st.tab === "map" && !channelView() && heat) {
      html += `<canvas class="hm-heat" id="hmheat" style="${box}"></canvas>`;
      if (plan) html += `<img class="hm-plan multiply" src="${plan}" style="${box};opacity:${st.planOpacity}" alt="" draggable="false">`;
    }
    let svg = "";
    if (st.tab === "walk" && s.spots.length > 1) svg += `<polyline points="${s.spots.map(p => V(p.x, p.y).join(",")).join(" ")}" class="hm-path"/>`;
    const focus = st.hoveredAP || st.infoAP;
    if (st.tab === "map" && st.highlight && Heatmap.shownNetwork(s) && focus) {
      const byKey = new Map(aps.map(a => [a.key, a]));
      for (const c of clashes.filter(c => c.a === focus || c.b === focus)) {
        const a = byKey.get(c.a), b = byKey.get(c.b); if (!a || !b) continue;
        const [x1, y1] = V(a.x, a.y), [x2, y2] = V(b.x, b.y);
        svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="hm-clash"/>`;
        html += `<span class="hm-clashlabel" style="left:${(x1 + x2) / 2}px;top:${(y1 + y2) / 2}px">${esc(c.label)} · strong together at ${c.spots} spot${c.spots === 1 ? "" : "s"}</span>`;
      }
    }
    if (st.scaling && st.scalePoints.length) {
      const pts = st.scalePoints.map(p => V(p.x, p.y));
      if (pts.length > 1) svg += `<line x1="${pts[0][0]}" y1="${pts[0][1]}" x2="${pts[1][0]}" y2="${pts[1][1]}" class="hm-scale"/>`;
      for (const [x, y] of pts) svg += `<circle cx="${x}" cy="${y}" r="5" class="hm-scaledot"/>`;
    }
    html += `<svg class="hm-svg" width="${L.size.width}" height="${L.size.height}">${svg}</svg>`;
    if (st.tab === "map" && Heatmap.shownNetwork(s)) {
      for (const ap of aps) {
        const on = (ap.key === st.apKey && st.mode === "oneAP") || st.hoveredAP === ap.key || st.drag?.ap === ap.key;
        const pos = st.drag?.ap === ap.key ? [st.drag.vx, st.drag.vy] : V(ap.x, ap.y);
        const bad = clashes.some(c => c.a === ap.key || c.b === ap.key);
        const tag = st.highlight && !on ? ap.bandReadings.find(r => r.band === st.clashBand) : null;
        const name = Heatmap.apName(s, ap.bssid, ap.ssid);
        html += `<div class="hm-ap${ap.placed ? " placed" : ""}${ap.key === st.apKey && st.mode === "oneAP" ? " sel" : ""}${on || st.highlight ? " on" : ""}${st.highlight && bad ? " clash" : ""}" data-ap="${esc(ap.key)}"
          style="left:${pos[0]}px;top:${pos[1]}px" title="${esc(ap.placed ? `${name}: placed by you. Drag to move; right-click for more.` : `${name}: estimated from where it was loudest. Drag it to where the access point really is.`)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.5a12 12 0 0 1 17 0M6.8 12.8a7.5 7.5 0 0 1 10.4 0M10 16a3 3 0 0 1 4 0"/><circle cx="12" cy="19" r="1.4"/></svg>
          ${ap.placed ? "" : '<b class="q">?</b>'}
          ${tag ? `<span class="hm-chtag${bad ? " bad" : ""}">ch ${tag.channel}</span>` : ""}
          ${on ? `<span class="hm-apname">${esc(name + (ap.placed ? "" : " (estimated)"))}</span>` : ""}</div>`;
      }
    }
    if (!channelView()) for (const p of s.spots) {
      const pos = st.drag?.spot === p.id ? [st.drag.vx, st.drag.vy] : V(p.x, p.y);
      const v = Heatmap.value(p, st.tab === "map" ? st.mode : "signal", st.tab === "map" ? filterFor(s) : { ssid: Heatmap.shownNetwork(s), band: "all" });
      const fill = v == null ? "#888" : Heatmap.css(Heatmap.level(v, st.tab === "map" ? st.mode : "signal"));
      html += `<div class="hm-spot ${st.tab}${st.selected === p.id ? " sel" : ""}" data-spot="${esc(p.id)}" style="left:${pos[0]}px;top:${pos[1]}px;--fill:${fill}" title="${esc(spotHelp(p, s))}"></div>`;
    }
    if (st.tab === "map" && !channelView()) {
      const weak = heat?.findings.find(f => f.spot), p = weak && s.spots.find(x => x.id === weak.spot);
      if (p) {
        const v = Heatmap.value(p, "signal", filterFor(s)) ?? Heatmap.silent, [x, y] = V(p.x, p.y);
        html += `<span class="hm-weak" style="left:${x}px;top:${y - 26}px">${v <= Heatmap.silent ? "Not heard" : `Weak: ${dBm(Math.trunc(v))}`}</span>`;
      }
    }
    if (st.busy) {
      const [x, y] = V(st.busy.x, st.busy.y);
      html += `<div class="hm-measuring" style="left:${x}px;top:${Math.max(40, y - 52)}px"><b>Measuring… hold still</b><span class="note">Scan ${st.busy.scan} of ${HEAT_SCANS}${st.busy.heard ? ` · ${st.busy.heard} networks` : ""}</span>
        <progress max="${HEAT_SCANS}" value="${st.busy.scan - 0.5}"></progress></div><div class="hm-busydot" style="left:${x}px;top:${y}px"></div>`;
    }
    stage.innerHTML = html;
    const hc = $("hmheat");
    if (hc && heat) { const c = heatCanvas(heat.grid); hc.width = c.width; hc.height = c.height; hc.getContext("2d").drawImage(c, 0, 0); }
  }
  function spotHelp(p, s) {
    const mine = p.readings.filter(r => Heatmap.matches({ ssid: Heatmap.shownNetwork(s), band: "all" }, r));
    const best = mine[0] ? `${Heatmap.apName(s, mine[0].bssid, mine[0].ssid)} ${dBm(mine[0].rssi)}` : "Your network wasn’t heard";
    return `${best} · ${p.readings.length} networks heard · ${new Date(p.date).toLocaleTimeString(undefined, { timeStyle: "short" })}`;
  }

  // The details card (a clicked spot or access point), in the map's top-left corner.
  function renderCard(s) {
    const card = $("hmcard");
    const spot = st.infoSpot && s.spots.find(p => p.id === st.infoSpot);
    const ap = st.infoAP && (st.heat?.aps || []).find(a => a.key === st.infoAP);
    card.hidden = !(spot || ap);
    if (!spot && !ap) return;
    let html = '<button type="button" class="hm-close" data-hm="closecard" aria-label="Close details">✕</button>';
    if (spot) {
      const n = s.spots.indexOf(spot) + 1, net = Heatmap.shownNetwork(s);
      const mine = spot.readings.filter(r => net == null || r.ssid === net).sort((a, b) => b.rssi - a.rssi);
      const others = spot.readings.filter(r => net != null && r.ssid !== net);
      const where = s.scale ? `${Math.round(spot.x / s.scale.pixelsPerUnit)}, ${Math.round(spot.y / s.scale.pixelsPerUnit)} ${s.scale.metres ? "m" : "ft"} from the top left` : "";
      html += `<h3>Spot ${n}</h3><p class="note">${esc([new Date(spot.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), where].filter(Boolean).join(" · "))}</p>
        ${spot.joinedSSID ? `<p>Connected to ${esc(spot.joinedSSID)}${spot.joinedBSSID ? ` via ${esc(Heatmap.apName(s, spot.joinedBSSID, spot.joinedSSID))}` : ""}</p>` : ""}
        ${spot.pingMs != null ? `<p>Ping to the router: ${Math.round(spot.pingMs)} ms</p>` : ""}<hr>
        <p class="hm-cap">${esc(net ? `${net} here` : "Networks here")}</p>
        ${mine.length ? `<table class="hm-mini">${mine.slice(0, 8).map(r => `<tr><td>${esc(Heatmap.apName(s, r.bssid, r.ssid))}</td><td class="note">${esc(r.band)} ch ${r.channel}</td><td class="num ${signalClass(r.rssi)}"><b>${dBm(r.rssi)}</b></td></tr>`).join("")}</table>`
          : '<p class="poor">Not heard at this spot.</p>'}
        <p class="note">${spot.readings.length} networks heard in all${others.length ? `, ${new Set(others.map(r => r.ssid)).size} of them other networks` : ""}</p>`;
    } else {
      const clash = Heatmap.channelClashes((st.heat?.aps || []).filter(a => a.worthShowing), s.spots).filter(c => c.a === ap.key || c.b === ap.key);
      html += `<h3>${esc(Heatmap.apName(s, ap.bssid, ap.ssid))}</h3><p class="note">${ap.placed ? "Placed by you" : "Position estimated from where it was loudest (drag it to place it)"}</p>
        <table class="hm-mini">${ap.bandReadings.map(r => `<tr><td><b>${esc(r.band)}</b></td><td class="note">ch ${r.channel} · ${r.widthMHz} MHz</td><td class="num ${signalClass(r.rssi)}">best ${dBm(r.rssi)}</td></tr>`).join("")}</table>
        <p class="note">Heard at ${ap.spotsHeard} of ${s.spots.length} spots · ${ap.radios} radio${ap.radios === 1 ? "" : "s"}</p>
        ${clash.map(c => { const other = c.a === ap.key ? c.b : c.a, o = (st.heat?.aps || []).find(a => a.key === other);
          return `<p class="poor">⚠ Shares ${esc(c.label)} (${esc(c.band)}) with ${esc(o ? Heatmap.apName(s, o.bssid, o.ssid) : other)}, both strong at ${c.spots} spot${c.spots === 1 ? "" : "s"}</p>`; }).join("")}
        <p class="mono note">${esc(ap.radioList.join("  "))}</p>
        <div class="hm-row"><button type="button" class="btn" data-hm="onlyap" data-key="${esc(ap.key)}">Show Only This</button><button type="button" class="btn" data-hm="nameap" data-key="${esc(ap.key)}">Name…</button>
        ${ap.placed ? `<button type="button" class="btn" data-hm="estimate" data-key="${esc(ap.key)}">Use Estimate</button>` : ""}</div>`;
    }
    card.innerHTML = html;
  }

  // Legend and zoom under the plan.
  function renderLegend(s) {
    const mode = HeatModes.find(m => m.id === st.mode);
    const grad = [0, 0.25, 0.5, 0.75, 1].map(l => Heatmap.css(l)).join(",");
    $("hmlegend").innerHTML = (st.tab === "map"
      ? `<span class="hm-cap">${Heatmap.isSignal(st.mode) ? "SIGNAL" : esc(mode.label.toUpperCase())}</span><span class="hm-gradwrap"><span class="hm-grad" style="background:linear-gradient(90deg,${grad})"></span>
          <span class="hm-gradlabels">${mode.legend.map(t => `<span>${esc(t)}</span>`).join("")}</span></span>`
      : [["Good", 0.9], ["Fair", 0.4], ["Poor", 0.1]].map(([t, l]) => `<span class="hm-key"><i style="background:${Heatmap.css(l)}"></i>${t}</span>`).join(""))
      + (s.scale ? `<span class="note">📏 Plan is ${Math.round(s.planWidth / s.scale.pixelsPerUnit)} × ${Math.round(s.planHeight / s.scale.pixelsPerUnit)} ${s.scale.metres ? "m" : "ft"}</span>` : "")
      + `<span class="note">${s.spots.length} spots measured</span>${st.tab === "walk" ? '<span class="note">Drag a spot to move it · right-click to delete</span>' : ""}<span class="grow"></span>
      <button type="button" class="hm-icon" data-hm="zoomout" aria-label="Zoom out" ${st.zoom <= 1.001 ? "disabled" : ""}>−</button>
      <input type="range" id="hmzoom" min="0" max="${Math.log2(HEAT_MAX_ZOOM)}" step="0.01" value="${Math.log2(st.zoom)}" aria-label="Zoom" title="Zoom (or pinch on the touchpad, or turn the mouse wheel)">
      <button type="button" class="hm-icon" data-hm="zoomin" aria-label="Zoom in" ${st.zoom >= HEAT_MAX_ZOOM - 0.001 ? "disabled" : ""}>+</button>
      <span class="note hm-pct">${Math.round(st.zoom * 100)}%</span><button type="button" class="btn small" data-hm="fit" title="Show the whole plan" ${st.zoom <= 1.001 ? "disabled" : ""}>Fit</button>`;
    $("hmzoom").oninput = e => zoomCentered(Math.pow(2, Number(e.target.value)));
  }

  // Sidebar
  function renderSide(s) {
    const side = $("hmside");
    const sec = t => `<div class="hm-sec">${esc(t.toUpperCase())}</div>`;
    if (st.tab === "walk") {
      const spot = s.spots.find(p => p.id === st.selected) || s.spots[s.spots.length - 1];
      const net = Heatmap.shownNetwork(s);
      side.innerHTML = `${sec("Measure with")}<p>💻 This PC’s Wi-Fi</p>
        <p class="note">The ARPradar Sensor (Pi) will show up here later, for 6 GHz and for iPhone.</p>
        <label class="check"><input type="checkbox" id="hmping" ${st.ping ? "checked" : ""}> Ping the router at each spot</label>
        <p class="note">Each spot takes ${HEAT_SCANS} scans and keeps the average. Windows can pause this PC’s Wi-Fi for a moment during each scan.</p>
        <div class="hm-head">${sec(spot && spot.id === st.selected ? "This spot" : spot ? "Last spot" : "This spot")}${spot ? `<span class="note">#${s.spots.indexOf(spot) + 1} · ${esc(new Date(spot.date).toLocaleTimeString(undefined, { timeStyle: "short" }))}</span>` : ""}</div>
        ${spot ? `<div class="hm-list"><div class="hm-lh"><span>Network · AP</span><span>Channel</span><span>dBm</span></div>
          ${spot.readings.slice(0, 12).map(r => { const mine = net == null || r.ssid === net;
            return `<div class="hm-lr${mine ? "" : " other"}"><span>${esc(mine ? Heatmap.apName(s, r.bssid, r.ssid) : r.ssid || "(hidden)")}</span><span>${r.channel} · ${esc(r.band.replace(" GHz", ""))}</span><span class="${mine ? signalClass(r.rssi) : ""}">${dBm(r.rssi)}</span></div>`; }).join("")}
          ${spot.readings.length > 12 ? `<div class="hm-lr other"><span>+ ${spot.readings.length - 12} more</span></div>` : ""}
          ${spot.pingMs != null ? `<div class="hm-lr"><span>Ping to router</span><span></span><span>${Math.round(spot.pingMs)} ms</span></div>` : ""}</div>
          <p class="note">${net ? `${esc(net)} in black, neighbors in grey. Right-click an AP in Map to name it.` : ""}</p>` : '<p class="note">Nothing measured yet.</p>'}
        ${!s.planFile || !s.scale ? `<div class="hm-tip"><b>Before you start</b>${!s.planFile ? "<p>Floor Plan › From a Picture or PDF… loads a plan of the building (or use a map picture).</p>" : ""}
          ${!s.scale ? "<p>Set Scale: click both ends of a wall and type its length. Then sizes and distances are in feet.</p>" : ""}</div>` : ""}`;
      $("hmping").onchange = e => { st.ping = e.target.checked; save("heatmap.ping", st.ping ? "1" : "0"); };
      return;
    }
    const aps = st.heat?.aps || [], f = filterFor(s);
    const cov = st.heat?.coverage;
    const clashes = st.highlight ? Heatmap.channelClashes(aps.filter(a => a.worthShowing), s.spots).filter(c => c.band === st.clashBand) : [];
    const name = k => { const a = aps.find(x => x.key === k); return a ? Heatmap.apName(s, a.bssid, a.ssid) : k; };
    side.innerHTML = `${sec("Show")}
      <div class="field"><label for="hmmode">Map of</label><select id="hmmode">${HeatModes.map(m => `<option value="${m.id}" ${m.id === st.mode ? "selected" : ""}>${m.label}</option>`).join("")}</select></div>
      <div class="field"><label for="hmnet">Network</label><select id="hmnet">${Heatmap.networkNames(s).map(n => `<option ${n === Heatmap.shownNetwork(s) ? "selected" : ""}>${esc(n)}</option>`).join("")}<option value="" ${Heatmap.shownNetwork(s) == null ? "selected" : ""}>All networks</option></select></div>
      ${st.mode === "oneAP" ? `<div class="field"><label for="hmap">Access point</label><select id="hmap">${aps.map(a => `<option value="${esc(a.key)}" ${a.key === (st.apKey || aps[0]?.key) ? "selected" : ""}>${esc(Heatmap.apName(s, a.bssid, a.ssid))}</option>`).join("")}</select></div>` : ""}
      <div class="segmented" id="hmband" role="group" aria-label="Band">${HeatBands.map(([v, t]) => `<button type="button" data-b="${v}" class="${v === st.band ? "on" : ""}">${t}</button>`).join("")}</div>
      ${s.planFile ? `<div class="hm-slider"><span class="note">Floor plan</span><input type="range" id="hmplanop" min="0" max="1" step="0.01" value="${st.planOpacity}" aria-label="Floor plan visibility" title="Fade the floor plan to see the heat colours better"><span class="note">${Math.round(st.planOpacity * 100)}%</span></div>` : ""}
      ${sec("Highlight")}
      <label class="check" title="Tags each access point with its channel on one band: red when it shares that channel with another AP where both are strong, green when it's clear. Point at an AP to see who it clashes with."><input type="checkbox" id="hmhl" ${st.highlight ? "checked" : ""}> Same channel</label>
      ${st.highlight ? `<p class="note">Showing only the access points on the map. Untick to see the heat colours and measured spots again.</p>
        <div class="segmented" id="hmcb" role="group" aria-label="Band">${["2.4 GHz", "5 GHz", "6 GHz"].map(b => `<button type="button" data-cb="${b}" class="${b === st.clashBand ? "on" : ""}">${b}</button>`).join("")}</div>
        ${clashes.length ? clashes.map(c => `<p class="hm-clashrow">● ${esc(name(c.a))} and ${esc(name(c.b))}: ${esc(c.label)}, strong together at ${c.spots} spot${c.spots === 1 ? "" : "s"}</p>`).join("")
          + '<p class="note">Where both are strong they take turns talking, so both slow down. Point at an access point to see its clashes. Give one a different channel, or lower their power.</p>'
          : `<p class="note">No clashes on ${esc(st.clashBand)}: no two of your access points on one channel are both strong (−70 dBm or better) in the same place.</p>`}` : ""}
      ${Heatmap.isSignal(st.mode) && cov?.measured ? `${sec("Coverage")}<div class="hm-cov"><i style="width:${cov.good * 100}%;background:${Heatmap.css(0.95)}"></i><i style="width:${cov.fair * 100}%;background:${Heatmap.css(0.5)}"></i><i style="width:${cov.poor * 100}%;background:${Heatmap.css(0.05)}"></i></div>
        <div class="hm-stats">${[[cov.good, "Good, −67 or better"], [cov.fair, "Fair, to −75"], [cov.poor, "Poor, below −75"]].map(([v, t]) => `<div><b>${Math.round(v * 100)}%</b><span class="note">${t}</span></div>`).join("")}</div>` : ""}
      ${sec("Access points heard")}
      ${!aps.length ? `<p class="note">${s.spots.length ? "None on this network and band." : "Nothing measured yet."}</p>` : `<div class="hm-list">
        ${aps.slice(0, 10).map(a => `<button type="button" class="hm-aprow${st.mode === "oneAP" && st.apKey === a.key ? " sel" : ""}" data-aprow="${esc(a.key)}">
          <span><b>${esc(Heatmap.apName(s, a.bssid, a.ssid))}</b><span class="note">${esc((a.bands.length > 1 ? a.bands.join(" + ") : `ch ${a.channel} · ${a.band} · ${a.widthMHz} MHz`) + (a.placed ? " · placed" : ""))}</span></span>
          <b class="${signalClass(a.best)}">${dBm(a.best)}</b></button>`).join("")}
        ${Heatmap.neighborCount(s.spots, f) ? `<div class="hm-lr other"><span>Neighbor networks</span><span></span><span>${Heatmap.neighborCount(s.spots, f)}</span></div>` : ""}</div>
        <p class="note">Click an AP to map it alone. Right-click to give it a name.</p>`}
      ${st.heat?.findings.length ? `${sec("Findings")}${st.heat.findings.map(x => `<p class="hm-finding ${x.level}">${{ good: "✓", info: "ⓘ", warn: "!", bad: "!" }[x.level]} ${esc(x.text)}</p>`).join("")}` : ""}
      ${s.spots[0] ? `<p class="note">Measured ${esc(new Date(s.spots[0].date).toLocaleDateString(undefined, { dateStyle: "medium" }))} with this PC’s Wi-Fi. Measure again after moving or adding an AP and compare.</p>` : ""}`;
    $("hmmode").onchange = e => { st.mode = e.target.value; if (st.mode === "oneAP" && !st.apKey) st.apKey = aps[0]?.key || null; render(); };
    $("hmnet").onchange = e => update(s.id, x => { x.network = e.target.value; });
    if ($("hmap")) $("hmap").onchange = e => { st.apKey = e.target.value; render(); };
    $("hmband").onclick = e => { const b = e.target.closest("[data-b]"); if (b) { st.band = b.dataset.b; render(); } };
    if ($("hmplanop")) $("hmplanop").oninput = e => { st.planOpacity = Number(e.target.value); save("heatmap.planOpacity", String(st.planOpacity)); drawStage(); e.target.nextElementSibling.textContent = `${Math.round(st.planOpacity * 100)}%`; };
    $("hmhl").onchange = e => { st.highlight = e.target.checked; save("heatmap.highlightChannels", st.highlight ? "1" : "0"); render(); };
    if ($("hmcb")) $("hmcb").onclick = e => { const b = e.target.closest("[data-cb]"); if (b) { st.clashBand = b.dataset.cb; save("heatmap.clashBand", st.clashBand); render(); } };
  }

  // MARK: Zoom (1 = the whole plan fits; up to 8 times that)

  /// Zooms keeping the stage point (px, py) at (vx, vy) in the window.
  function zoomTo(wanted, px, py, vx, vy) {
    const s = current(); if (!s) return;
    const z = Math.min(HEAT_MAX_ZOOM, Math.max(1, wanted));
    if (Math.abs(z - st.zoom) < 0.001) return;
    const a = geometry(s);
    const plan = { x: (px - a.origin.x) / a.k, y: (py - a.origin.y) / a.k };
    st.zoom = z;
    const b = geometry(s);
    drawStage(); renderLegend(s);
    const sc = $("hmscroll");
    sc.scrollLeft = b.origin.x + plan.x * b.k - vx; sc.scrollTop = b.origin.y + plan.y * b.k - vy;
  }
  function zoomCentered(z) { const sc = $("hmscroll"); const vx = sc.clientWidth / 2, vy = sc.clientHeight / 2; zoomTo(z, sc.scrollLeft + vx, sc.scrollTop + vy, vx, vy); }
  /// Ctrl+wheel (and touchpad pinch, which Windows sends as Ctrl+wheel) or a mouse wheel's notches zoom around the
  /// pointer; a touchpad's two-finger scroll still pans.
  $("hmscroll").addEventListener("wheel", e => {
    const mouseNotch = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY) && e.deltaX === 0);
    if (!e.ctrlKey && !mouseNotch) return;
    e.preventDefault();
    const sc = $("hmscroll"), r = sc.getBoundingClientRect(), vx = e.clientX - r.left, vy = e.clientY - r.top;
    const steps = Math.max(-3, Math.min(3, -e.deltaY / (e.ctrlKey && !mouseNotch ? 10 : 100)));
    zoomTo(st.zoom * Math.pow(1.15, steps), sc.scrollLeft + vx, sc.scrollTop + vy, vx, vy);
  }, { passive: false });
  window.addEventListener("resize", () => current() && drawStage());

  // MARK: Clicks, drags and menus

  const planPoint = (s, e) => {
    const L = geometry(s), r = $("hmstage").getBoundingClientRect();
    return { x: (e.clientX - r.left - L.origin.x) / L.k, y: (e.clientY - r.top - L.origin.y) / L.k };
  };
  let press = null;
  $("hmstage").addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const s = current(); if (!s) return;
    const spotEl = e.target.closest("[data-spot]"), apEl = e.target.closest("[data-ap]");
    press = { x: e.clientX, y: e.clientY, spot: st.tab === "walk" ? spotEl?.dataset.spot : null, ap: st.tab === "map" ? apEl?.dataset.ap : null, moved: false, target: e.target };
    if (press.spot || press.ap) $("hmstage").setPointerCapture(e.pointerId);
  });
  $("hmstage").addEventListener("pointermove", e => {
    if (!press) {
      // Hover over an access point shows its name (and its clash lines).
      const ap = e.target.closest?.("[data-ap]")?.dataset.ap || null;
      if (ap !== st.hoveredAP && current() && st.tab === "map") { st.hoveredAP = ap; drawStage(); }
      return;
    }
    if (!press.spot && !press.ap) return;
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 3) return;
    press.moved = true;
    const r = $("hmstage").getBoundingClientRect();
    st.drag = { spot: press.spot, ap: press.ap, vx: e.clientX - r.left, vy: e.clientY - r.top };
    drawStage();
  });
  $("hmstage").addEventListener("pointerup", e => {
    const s = current(), p = press; press = null;
    if (!s || !p) return;
    if (p.moved && (p.spot || p.ap)) {
      const q = planPoint(s, e);
      const x = Math.min(Math.max(q.x, 0), s.planWidth), y = Math.min(Math.max(q.y, 0), s.planHeight);
      st.drag = null;
      if (p.spot) update(s.id, sv => { const sp = sv.spots.find(z => z.id === p.spot); if (sp) { sp.x = x; sp.y = y; } });
      else update(s.id, sv => { sv.apPlaces[p.ap] = { x, y }; });
      return;
    }
    const spotId = p.target.closest?.("[data-spot]")?.dataset.spot, apKey = p.target.closest?.("[data-ap]")?.dataset.ap;
    if (spotId) { st.selected = spotId; st.infoSpot = spotId; st.infoAP = null; render(); return; }
    if (apKey) { st.infoAP = apKey; st.infoSpot = null; render(); return; }
    const q = planPoint(s, e);
    if (q.x < 0 || q.y < 0 || q.x > s.planWidth || q.y > s.planHeight) return;
    if (st.scaling) {
      st.scalePoints.push(q);
      if (st.scalePoints.length === 2) askScale(s); else drawStage();
      renderBanner(s);
      return;
    }
    if (st.tab === "walk") measure(q);
  });
  $("hmstage").addEventListener("contextmenu", e => {
    const s = current(); if (!s) return;
    const spotId = e.target.closest("[data-spot]")?.dataset.spot, apKey = e.target.closest("[data-ap]")?.dataset.ap;
    if (spotId) { e.preventDefault(); popMenu([{ label: "Delete Spot", run: () => update(s.id, x => { x.spots = x.spots.filter(p => p.id !== spotId); if (st.selected === spotId) st.selected = null; }) }], e.clientX, e.clientY); }
    else if (apKey) { e.preventDefault(); const ap = (st.heat?.aps || []).find(a => a.key === apKey); if (ap) popMenu(apMenu(ap, s), e.clientX, e.clientY); }
  });
  $("hmside").addEventListener("click", e => {
    const row = e.target.closest("[data-aprow]"); if (!row) return;
    st.mode = "oneAP"; st.apKey = row.dataset.aprow; render();
  });
  $("hmside").addEventListener("contextmenu", e => {
    const row = e.target.closest("[data-aprow]"), s = current(); if (!row || !s) return;
    e.preventDefault();
    const ap = (st.heat?.aps || []).find(a => a.key === row.dataset.aprow); if (ap) popMenu(apMenu(ap, s), e.clientX, e.clientY);
  });
  $("hmside").addEventListener("mouseover", e => { const k = e.target.closest("[data-aprow]")?.dataset.aprow || null; if (k !== st.hoveredAP && st.tab === "map") { st.hoveredAP = k; drawStage(); } });

  function apMenu(ap, s) {
    const others = (st.heat?.aps || []).filter(a => a.key !== ap.key);
    return [
      { label: "Show Only This Access Point", run: () => { st.mode = "oneAP"; st.apKey = ap.key; render(); } },
      { label: "Name This Access Point…", run: () => nameAP(s, ap.key) }, { sep: true },
      ...(others.length ? [{ label: "Combine With ▸", run: () => setTimeout(() => popMenu(others.map(o => ({ label: `${Heatmap.apName(s, o.bssid, o.ssid)} · ${o.bands.join(" + ")}`, run: () => combine(ap, o, s) })), lastMenu[0], lastMenu[1]), 0) }] : []),
      ...(ap.radios > 1 ? [{ label: `Separate Radios (${ap.radios})`, run: () => separate(ap, s) }] : []),
      ...(ap.radioList.some(r => s.apOverrides[r] != null) ? [{ label: "Undo Combine or Separate", run: () => update(s.id, x => { for (const r of ap.radioList) delete x.apOverrides[r]; }) }] : []),
      { sep: true },
      ...(ap.placed ? [{ label: "Use Estimated Position", run: () => update(s.id, x => { delete x.apPlaces[ap.key]; }) }] : []),
      { label: "Copy BSSID", run: () => copyText(ap.bssid) },
    ];
  }
  /// Every radio of `ap` (and of `target`) goes with `target`; its name and placed position carry over.
  function combine(ap, target, s) {
    update(s.id, x => {
      for (const r of [...ap.radioList, ...target.radioList]) x.apOverrides[r] = target.key;
      if (!x.apNames[target.key] && x.apNames[ap.key]) x.apNames[target.key] = x.apNames[ap.key];
      if (!x.apPlaces[target.key] && x.apPlaces[ap.key]) x.apPlaces[target.key] = x.apPlaces[ap.key];
      delete x.apNames[ap.key]; delete x.apPlaces[ap.key];
    });
    if (st.apKey === ap.key) st.apKey = target.key;
  }
  function separate(ap, s) { update(s.id, x => { for (const r of ap.radioList) x.apOverrides[r] = r; }); if (st.apKey === ap.key) st.apKey = null; }
  function nameAP(s, key) { ask("Name This Access Point", s.apNames[key] || "", v => update(s.id, x => { if (v.trim()) x.apNames[key] = v.trim(); else delete x.apNames[key]; })); }

  let lastMenu = [0, 0];
  function popMenu(items, x, y) {
    document.querySelectorAll(".menu.hm-pop").forEach(m => m.remove());
    lastMenu = [x, y];
    const m = document.createElement("div"); m.className = "menu hm-pop"; m.setAttribute("role", "menu");
    m.innerHTML = items.map((it, i) => it.sep ? "<hr>" : it.heading ? `<div class="heading">${esc(it.heading)}</div>`
      : `<button type="button" data-i="${i}" ${it.disabled ? "disabled" : ""}>${it.checked ? "✓ " : ""}${esc(it.label)}</button>`).join("");
    document.body.appendChild(m);
    m.style.left = `${Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 8))}px`; m.style.top = `${Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 8))}px`;
    const close = () => { m.remove(); document.removeEventListener("pointerdown", away, true); };
    const away = ev => { if (!m.contains(ev.target)) close(); };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    m.onclick = ev => { const b = ev.target.closest("[data-i]"); if (!b) return; close(); items[Number(b.dataset.i)].run?.(); };
  }

  // Toolbar, card and legend buttons.
  root.addEventListener("click", async e => {
    const b = e.target.closest("[data-hm]"); if (!b) return;
    const s = current(), r = b.getBoundingClientRect();
    switch (b.dataset.hm) {
      case "new": return ask("New Heatmap", uniqueName("Floor 1"), v => create(v.trim() || "Floor 1"));
      case "pick": return popMenu(heatmapMenu(s), r.left, r.bottom + 2);
      case "plan": return popMenu(planMenu(s), r.left, r.bottom + 2);
      case "scale": st.scaling = !st.scaling; st.scalePoints = []; return render();
      case "walk": case "map": st.tab = b.dataset.hm; return render();
      case "undo": return update(s.id, x => { x.spots.pop(); st.selected = null; });
      case "done": st.tab = "map"; return render();
      case "export": return exportPNG(s);
      case "update": { const o = Orgs.org(s.orgID), d = Heatmap.draft(s, filterFor(s), st.heat.coverage); if (o && d) await Orgs.addItem(o.id, d); b.textContent = `Updated ✓`; return; }
      case "closecard": st.infoSpot = st.infoAP = null; return render();
      case "onlyap": st.mode = "oneAP"; st.apKey = b.dataset.key; st.infoAP = null; return render();
      case "nameap": st.infoAP = null; return nameAP(s, b.dataset.key);
      case "estimate": st.infoAP = null; return update(s.id, x => { delete x.apPlaces[b.dataset.key]; });
      case "zoomout": return zoomCentered(st.zoom / 1.25);
      case "zoomin": return zoomCentered(st.zoom * 1.25);
      case "fit": st.zoom = 1; drawStage(); renderLegend(s); $("hmscroll").scrollTo(0, 0); return;
    }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && (st.infoSpot || st.infoAP)) { st.infoSpot = st.infoAP = null; render(); } });

  function heatmapMenu(s) {
    const items = [];
    // Grouped like saved scans: each organization's heatmaps, then the standalone ones.
    const pick = x => ({ label: x.name, checked: x.id === s?.id, run: () => { setCurrent(x.id); render(); } });
    for (const o of Orgs.list) { const mine = st.surveys.filter(x => x.orgID === o.id); if (mine.length) items.push({ heading: o.name }, ...mine.map(pick)); }
    const loose = st.surveys.filter(x => !x.orgID || !Orgs.org(x.orgID));
    if (loose.length) items.push({ heading: "Standalone" }, ...loose.map(pick));
    if (st.surveys.length) items.push({ sep: true });
    items.push({ label: "New Heatmap…", run: () => ask("New Heatmap", uniqueName("Floor 1"), v => create(v.trim() || "Floor 1")) });
    if (s) items.push(
      { label: "Save as New Heatmap…", run: () => ask("Save as New Heatmap", uniqueName(s.name + " copy"), v => duplicate(s, v.trim() || s.name + " copy")) },
      { label: "Rename…", run: () => ask("Rename Heatmap", s.name, v => { if (v.trim()) update(s.id, x => { x.name = v.trim(); }); }) },
      { label: "Move to Recycle Bin…", run: () => confirmIt(`Move “${s.name}” to the Recycle Bin?`, "Its floor plan and every spot measured go with it. You can get it back from the Recycle Bin.", "Move to Recycle Bin", async () => {
        try { await invoke("heatmap_delete", { id: s.id }); } catch (e) { problem(String(e)); return; }
        st.surveys = st.surveys.filter(x => x.id !== s.id); setCurrent(st.surveys[0]?.id); render();
      }) });
    return items;
  }
  /// Save as New Heatmap: a copy (floor plan, scale, spots, AP names), standalone until it's saved to an organization.
  async function duplicate(s, name) {
    const copy = { ...JSON.parse(JSON.stringify(s)), id: Heatmap.newId(), name: uniqueName(name), created: new Date().toISOString(), orgID: null };
    try { await invoke("heatmap_duplicate", { from: s.id, to: copy.id }); await write(copy); } catch (e) { return problem(String(e)); }
    st.surveys.unshift(copy); setCurrent(copy.id); st.tab = "walk"; render();
  }
  function planMenu(s) {
    return [
      { label: "From a Picture or PDF…", run: () => pickPlan(s) },
      { label: "From a Map Picture…", run: () => pickMap(s, false) },
      { sep: true },
      // Needs a map picture underneath. A plan picture already here can be that; otherwise pick a map picture first.
      { label: "Lay a Floor Plan Over the Map…", run: () => s.baseFile ? pickOverlay(s) : s.planFile ? askUseCurrent(s) : pickMap(s, true) },
      ...(s.overlay ? [{ label: "Adjust Floor Plan Overlay…", run: () => composer(s) }, { label: "Remove Floor Plan Overlay", run: () => removeOverlay(s) }] : []),
    ];
  }
  async function pickPlan(s) {
    const file = await pickFile("Choose a floor plan: a picture or PDF of the building."); if (!file) return;
    try { await setPlan(s, await filePNG(file)); await update(s.id, x => { x.baseFile = null; x.overlay = null; }); st.zoom = 1; render(); }   // a plan of its own: no map underneath any more
    catch (e) { problem(e.message || String(e)); }
  }
  /// A map or satellite picture (a screenshot of an area you're allowed to use) as the plan, kept as the base a
  /// floor plan can be laid over. Set Scale afterwards (Windows has no built-in map with a scale yet).
  async function pickMap(s, thenOverlay) {
    const file = await pickFile("Choose a map or satellite picture of the area."); if (!file) return;
    try { await setPlan(s, await filePNG(file)); await keepPlanAsBase(current()); st.zoom = 1; render(); if (thenOverlay) pickOverlay(current()); }
    catch (e) { problem(e.message || String(e)); }
  }
  function askUseCurrent(s) {
    const m = document.createElement("div"); m.className = "backdrop";
    m.innerHTML = `<div class="modal"><h2>Lay the floor plan over this heatmap’s current picture?</h2>
      <p>Use the map picture this heatmap already has as the map underneath, so your spots and scale stay as they are. Or pick a new map picture.</p>
      <div class="buttons"><button type="button" data-no>Cancel</button><button type="button" data-map>Choose a Map Picture…</button><button type="button" class="primary">Use the Current Picture</button></div></div>`;
    $("modal-root").appendChild(m);
    m.querySelector("[data-no]").onclick = () => m.remove();
    m.querySelector("[data-map]").onclick = () => { m.remove(); pickMap(s, true); };
    m.querySelector(".primary").onclick = async () => { m.remove(); await keepPlanAsBase(s); pickOverlay(current()); };
  }
  /// Loads a floor plan to lay over the map picture; keeps it as loaded and with its paper removed.
  async function pickOverlay(s) {
    const file = await pickFile("Choose a floor plan to lay over the map: a picture or PDF of the building."); if (!file) return;
    try {
      const png = await filePNG(file);
      const img = await loadImage(png.url), c = document.createElement("canvas");
      c.width = png.width; c.height = png.height;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height); Heatmap.stripBackground(data.data); g.clearRect(0, 0, c.width, c.height); g.putImageData(data, 0, 0);
      await writePicture(s, "overlay-original.png", png.url);
      await writePicture(s, "overlay.png", c.toDataURL("image/png"));
      // Start in the middle, half as wide as the map picture.
      await update(s.id, x => { x.overlay = { cx: x.planWidth / 2, cy: x.planHeight / 2, width: x.planWidth * 0.5, rotation: 0, opacity: 0.85, stripped: true, white: false, mapOpacity: 1 }; });
      composer(current());
    } catch (e) { problem(e.message || String(e)); }
  }
  async function removeOverlay(s) {
    try { await invoke("heatmap_copy_file", { id: s.id, from: "base.png", to: "plan.png" }); } catch (e) { return problem(String(e)); }
    update(s.id, x => { x.overlay = null; x.planVersion = Date.now(); });
  }

  /// Floor Plan › Lay a Floor Plan Over the Map: drag it into place, then size, turn and fade it to line it up.
  async function composer(s) {
    const [base, original, stripped] = await Promise.all([readPicture(s, "base.png"), readPicture(s, "overlay-original.png"), readPicture(s, "overlay.png")]);
    if (!base || !s.overlay) return problem("There’s no floor plan over a map in this heatmap yet.");
    const baseImg = await loadImage(base), bw = baseImg.naturalWidth, bh = baseImg.naturalHeight;
    const o = { ...s.overlay };
    let zoom = 1;
    const m = document.createElement("div"); m.className = "backdrop";
    m.innerHTML = `<div class="modal hm-composer"><h2>Line up the floor plan with the map</h2>
      <p class="note">Drag the floor plan onto the building. Use Size to scale it (or Ctrl+scroll over it), and Turn to rotate it, until the walls sit on the roof lines. Zoom in (or Ctrl+scroll over the map) for the fine lining up; fade the map or switch the plan to white lines to see both better.</p>
      <div class="hm-cview" id="cv"><div class="hm-cstage" id="cs"><div class="hm-cwhite"></div><img id="cbase" src="${base}" alt="" draggable="false"><img id="cplan" alt="" draggable="false"></div></div>
      <div class="hm-cgrid">
        <span class="note">Size</span><input type="range" id="csize" min="-4.3" max="2" step="0.01"><span class="note" id="csizet"></span>
        <span class="note">Turn</span><input type="range" id="cturn" min="-180" max="180" step="0.5"><span class="hm-row"><button type="button" class="btn small" data-t="-90">−90°</button><button type="button" class="btn small" data-t="90">+90°</button><span class="note" id="cturnt"></span></span>
        <span class="note">Plan</span><input type="range" id="cop" min="0.2" max="1" step="0.01"><span class="hm-row"><span class="note" id="copt"></span><span class="segmented small" id="cbw"><button type="button" data-w="0">Black</button><button type="button" data-w="1">White</button></span></span>
        <span class="note">Map</span><input type="range" id="cmap" min="0.15" max="1" step="0.01"><span class="note" id="cmapt"></span>
        <span class="note">Zoom</span><input type="range" id="czoom" min="0" max="3" step="0.01" value="0"><span class="hm-row"><span class="note" id="czoomt"></span><button type="button" class="btn small" id="cfit">Fit</button></span>
      </div>
      <div class="buttons"><label class="check left"><input type="checkbox" id="cstrip" ${original && stripped ? "" : "disabled"}> Remove the plan’s white background</label>
        <button type="button" data-no>Cancel</button><button type="button" class="primary">Done</button></div></div>`;
    $("modal-root").appendChild(m);
    const q = sel => m.querySelector(sel), view = q("#cv");
    const draw = () => {
      const k = Math.min(view.clientWidth / bw, view.clientHeight / bh) * zoom;
      const w = Math.max(view.clientWidth, bw * k), h = Math.max(view.clientHeight, bh * k), ox = (w - bw * k) / 2, oy = (h - bh * k) / 2;
      Object.assign(q("#cs").style, { width: `${w}px`, height: `${h}px` });
      Object.assign(q(".hm-cwhite").style, { left: `${ox}px`, top: `${oy}px`, width: `${bw * k}px`, height: `${bh * k}px` });
      Object.assign(q("#cbase").style, { left: `${ox}px`, top: `${oy}px`, width: `${bw * k}px`, height: `${bh * k}px`, opacity: o.mapOpacity });
      const plan = q("#cplan"), src = o.stripped ? stripped : original;
      if (plan.getAttribute("src") !== src) plan.src = src;
      Object.assign(plan.style, { left: `${ox + o.cx * k}px`, top: `${oy + o.cy * k}px`, width: `${o.width * k}px`, opacity: o.opacity,
        transform: `translate(-50%, -50%) rotate(${o.rotation}deg)`, filter: o.white ? "brightness(0) invert(1)" : "none" });
      q("#csize").value = Math.log2(o.width / bw); q("#csizet").textContent = `${Math.round(o.width / bw * 100)}% of the map`;
      q("#cturn").value = o.rotation; q("#cturnt").textContent = `${Math.round(o.rotation)}°`;
      q("#cop").value = o.opacity; q("#copt").textContent = `${Math.round(o.opacity * 100)}% solid`;
      q("#cmap").value = o.mapOpacity; q("#cmapt").textContent = `${Math.round(o.mapOpacity * 100)}% (fade the map)`;
      q("#czoomt").textContent = `${Math.round(zoom * 100)}%`; q("#cfit").disabled = zoom <= 1.001;
      q("#cbw").querySelectorAll("button").forEach(x => x.classList.toggle("on", (x.dataset.w === "1") === o.white));
      q("#cstrip").checked = o.stripped;
      return k;
    };
    let k = draw();
    q("#csize").oninput = e => { o.width = bw * Math.pow(2, Number(e.target.value)); k = draw(); };
    q("#cturn").oninput = e => { o.rotation = Number(e.target.value); k = draw(); };
    q("#cop").oninput = e => { o.opacity = Number(e.target.value); k = draw(); };
    q("#cmap").oninput = e => { o.mapOpacity = Number(e.target.value); k = draw(); };
    q("#czoom").oninput = e => { zoom = Math.pow(2, Number(e.target.value)); k = draw(); };
    q("#cfit").onclick = () => { zoom = 1; q("#czoom").value = 0; k = draw(); };
    m.querySelectorAll("[data-t]").forEach(x => x.onclick = () => { o.rotation = Heatmap.wrap(o.rotation + Number(x.dataset.t)); k = draw(); });
    q("#cbw").onclick = e => { const x = e.target.closest("[data-w]"); if (x) { o.white = x.dataset.w === "1"; k = draw(); } };
    q("#cstrip").onchange = e => { o.stripped = e.target.checked; k = draw(); };
    // Drag the plan to move it; Ctrl+wheel over the plan sizes it, over the map zooms the view.
    let start = null;
    q("#cplan").onpointerdown = e => { start = { x: e.clientX, y: e.clientY, cx: o.cx, cy: o.cy }; e.target.setPointerCapture(e.pointerId); e.preventDefault(); };
    q("#cplan").onpointermove = e => { if (!start) return; o.cx = start.cx + (e.clientX - start.x) / k; o.cy = start.cy + (e.clientY - start.y) / k; k = draw(); };
    q("#cplan").onpointerup = () => { start = null; };
    view.addEventListener("wheel", e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.005);
      if (e.target.id === "cplan") o.width = Math.min(bw * 4, Math.max(bw * 0.05, o.width * f));
      else { zoom = Math.min(8, Math.max(1, zoom * f)); q("#czoom").value = Math.log2(zoom); }
      k = draw();
    }, { passive: false });
    q("[data-no]").onclick = () => m.remove();
    q(".primary").onclick = async () => {
      m.remove();
      try { await applyOverlay(current(), o, baseImg, o.stripped ? stripped : original); } catch (e) { problem(e.message || String(e)); }
    };
  }
  /// Puts the floor plan on the map picture and makes that the heatmap's plan (same size, so spots and scale hold).
  async function applyOverlay(s, o, baseImg, planSrc) {
    if (!planSrc) throw new Error("The floor plan picture is missing.");
    const plan = await loadImage(planSrc), w = baseImg.naturalWidth, h = baseImg.naturalHeight;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d");
    // The map, faded towards white as asked.
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
    g.globalAlpha = o.mapOpacity; g.drawImage(baseImg, 0, 0, w, h);
    const ow = o.width, oh = o.width * plan.naturalHeight / plan.naturalWidth;
    g.translate(o.cx, o.cy); g.rotate(o.rotation * Math.PI / 180);
    g.globalAlpha = o.opacity; if (o.white) g.filter = "brightness(0) invert(1)";
    g.drawImage(plan, -ow / 2, -oh / 2, ow, oh);
    await writePicture(s, "plan.png", c.toDataURL("image/png"));
    await update(s.id, x => { x.overlay = o; x.planFile = "plan.png"; x.planWidth = w; x.planHeight = h; x.planVersion = Date.now(); });
  }

  function askScale(s) {
    const m = document.createElement("div"); m.className = "backdrop";
    const metres = !!s.scale?.metres;
    m.innerHTML = `<div class="modal"><h2>How long is the line you drew?</h2><div class="hm-row"><input id="slen" class="entry" style="width:100px" aria-label="Length">
      <span class="segmented small" id="sunit"><button type="button" data-m="0" class="${metres ? "" : "on"}">feet</button><button type="button" data-m="1" class="${metres ? "on" : ""}">metres</button></span></div>
      <div class="buttons"><button type="button" data-no>Cancel</button><button type="button" class="primary" disabled>Set Scale</button></div></div>`;
    $("modal-root").appendChild(m);
    let inMetres = metres;
    const len = () => Number(m.querySelector("#slen").value.replace(",", "."));
    const done = () => { m.remove(); st.scaling = false; st.scalePoints = []; render(); };
    m.querySelector("#slen").oninput = () => { m.querySelector(".primary").disabled = !(len() > 0); };
    m.querySelector("#sunit").onclick = e => { const b = e.target.closest("[data-m]"); if (!b) return; inMetres = b.dataset.m === "1"; m.querySelectorAll("#sunit button").forEach(x => x.classList.toggle("on", x === b)); };
    m.querySelector("[data-no]").onclick = done;
    m.querySelector(".primary").onclick = () => {
      const [a, b] = st.scalePoints, px = Math.hypot(b.x - a.x, b.y - a.y), l = len();
      if (px > 2 && l > 0) update(s.id, x => { x.scale = { pixelsPerUnit: px / l, metres: inMetres }; });
      done();
    };
    m.querySelector("#slen").onkeydown = e => { if (e.key === "Enter" && len() > 0) m.querySelector(".primary").click(); if (e.key === "Escape") done(); };
    setTimeout(() => m.querySelector("#slen").focus(), 0);
  }

  /// Export PNG: the plan, the map, the spots, AP labels and a legend, on white.
  async function exportPNG(s) {
    const k = Math.min(1, 2400 / Math.max(s.planWidth, s.planHeight)), w = Math.round(s.planWidth * k), h = Math.round(s.planHeight * k), pad = 24;
    const c = document.createElement("canvas"); c.width = w + pad * 2; c.height = h + pad * 2 + 70;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    const f = filterFor(s), mode = HeatModes.find(m => m.id === st.mode);
    g.fillStyle = "#000"; g.font = "600 20px 'Segoe UI', system-ui, sans-serif";
    g.fillText(`${s.name} · ${mode.label}${f.ssid ? ` · ${f.ssid}` : ""}${f.band === "all" ? "" : ` · ${f.band}${f.band === "6" ? " GHz" : " GHz"}`}`, pad, pad + 20);
    const top = pad + 36, planSrc = await planURL(s);
    const plan = planSrc ? await loadImage(planSrc) : null;
    if (plan) g.drawImage(plan, pad, top, w, h);
    if (st.heat) {
      g.imageSmoothingQuality = "high"; g.drawImage(heatCanvas(st.heat.grid), pad, top, w, h);
      if (plan) { g.globalCompositeOperation = "multiply"; g.drawImage(plan, pad, top, w, h); g.globalCompositeOperation = "source-over"; }
    }
    for (const p of s.spots) {
      const v = Heatmap.value(p, st.mode, f);
      g.beginPath(); g.arc(pad + p.x * k, top + p.y * k, 5, 0, Math.PI * 2);
      g.fillStyle = v == null ? "#888" : Heatmap.css(Heatmap.level(v, st.mode)); g.fill(); g.lineWidth = 2; g.strokeStyle = "#fff"; g.stroke();
    }
    if (f.ssid) {
      g.font = "600 12px 'Segoe UI', system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      for (const ap of (st.heat?.aps || []).filter(a => a.worthShowing)) {
        const t = `AP · ${Heatmap.apName(s, ap.bssid, ap.ssid)}${ap.placed ? "" : " (est.)"}`, tw = g.measureText(t).width + 12, x = pad + ap.x * k, y = top + ap.y * k;
        g.globalAlpha = ap.placed ? 1 : 0.75; g.fillStyle = "#fff"; g.strokeStyle = "#000"; g.lineWidth = 1;
        g.beginPath(); g.roundRect(x - tw / 2, y - 10, tw, 20, 10); g.fill(); g.stroke(); g.fillStyle = "#000"; g.fillText(t, x, y); g.globalAlpha = 1;
      }
      g.textAlign = "left"; g.textBaseline = "alphabetic";
    }
    const ly = top + h + 22, grad = g.createLinearGradient(pad, 0, pad + 300, 0);
    [0, 0.25, 0.5, 0.75, 1].forEach(l => grad.addColorStop(l, Heatmap.css(l)));
    g.fillStyle = grad; g.fillRect(pad, ly, 300, 10);
    g.fillStyle = "#000"; g.font = "12px 'Segoe UI', system-ui, sans-serif"; g.fillText(mode.legend.join("  ·  "), pad + 312, ly + 10);
    const cov = st.heat?.coverage;
    const right = `${cov?.measured && Heatmap.isSignal(st.mode) ? `${Math.round(cov.good * 100)}% good · ${Math.round(cov.fair * 100)}% fair · ${Math.round(cov.poor * 100)}% poor   ` : ""}${s.spots.length} spots · ARPradar`;
    g.fillStyle = "#666"; g.fillText(right, pad + w - g.measureText(right).width, ly + 10);
    const bytes = Uint8Array.from(atob(c.toDataURL("image/png").split(",")[1]), ch => ch.charCodeAt(0));
    try { await invoke("export_bytes", { fileName: `${s.name} heatmap.png`.replace(/[\\/:*?"<>|]/g, "-"), data: Array.from(bytes), kind: "png" }); }
    catch (e) { problem(String(e)); }
  }

  function problem(text) {
    const m = document.createElement("div"); m.className = "backdrop";
    m.innerHTML = `<div class="modal"><h2>Heatmap</h2><p>${esc(text)}</p><div class="buttons"><button type="button" class="primary">OK</button></div></div>`;
    $("modal-root").appendChild(m);
    m.querySelector(".primary").onclick = () => m.remove();
  }

  // MARK: Start

  await loadAll();
  // The latest scan's network map, for UniFi access point names (read once; the window can be reopened for a newer one).
  try { const d = JSON.parse(await invoke("load_data") || "{}"); st.uniFi = (d.history || []).find(r => r.netMap)?.netMap || null; } catch {}
  /// Opening a particular heatmap (an organization's saved entry) arrives as "heatmap:<id>".
  const openArg = a => { const id = String(a || "").replace(/^heatmap:/, ""); if (id && st.surveys.some(s => s.id === id)) { setCurrent(id); st.tab = "map"; } };
  openArg(arg);
  Orgs.onChange(() => render());
  render();
  return async a => { await loadAll(); openArg(a); render(); };
}
