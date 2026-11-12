// The Wi-Fi Heatmap's data and math (same as the Mac's Heatmap/HeatmapModel.swift and HeatmapOverlay.swift).
// No window code here, so tests/heatmap.test.js can run it in Node. The window is in heatmapview.js.
//
// A heatmap ("survey"), saved as heatmap.json next to its pictures:
//   {id, name, created, planWidth, planHeight, planFile, scale: {pixelsPerUnit, metres}, spots: [spot], apNames,
//    apPlaces: {key: {x, y}}, apOverrides: {bssid: key}, baseFile, overlay, network, orgID}
// A spot: {id, x, y (plan pixels), date, readings: [{ssid, bssid, rssi, channel, band, widthMHz}], joinedSSID,
//          joinedBSSID, pingMs}
"use strict";

const HeatModes = [
  { id: "signal", label: "Best signal", legend: ["−85", "−75", "−67", "−60", "−45 dBm"] },
  { id: "oneAP", label: "One access point", legend: ["−85", "−75", "−67", "−60", "−45 dBm"] },
  { id: "apCount", label: "Access points heard", legend: ["0", "1", "2", "3+ APs at −75 or better"] },
  { id: "overlap", label: "Channel overlap", legend: ["3+", "2", "1", "0 networks on the same channel"] },
  { id: "ping", label: "Ping to router", legend: ["100+", "60", "30", "10 ms"] },
];
const HeatBands = [["all", "All"], ["2.4", "2.4"], ["5", "5"], ["6", "6 GHz"]];

const Heatmap = (() => {
  /// What "no signal" counts as when a spot didn't hear the network at all.
  const silent = -95;
  const blankSize = { width: 1600, height: 1000 };
  const isSignal = mode => mode === "signal" || mode === "oneAP";
  const bandMatches = (band, b) => band === "all" || (band === "2.4" && b === "2.4 GHz") || (band === "5" && b === "5 GHz") || (band === "6" && b === "6 GHz");
  /// filter: {ssid (null = every network), band, bssid (one AP's key), radios (Set of BSSIDs)}
  const matches = (f, r) => (f.ssid == null || r.ssid === f.ssid) && bandMatches(f.band || "all", r.band);
  const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`).toUpperCase();

  function newSurvey(name) {
    return { id: newId(), name, created: new Date().toISOString(), planWidth: blankSize.width, planHeight: blankSize.height, planFile: null,
      scale: null, spots: [], apNames: {}, apPlaces: {}, apOverrides: {}, baseFile: null, overlay: null, network: null, orgID: null };
  }
  /// A survey read from heatmap.json, with every field filled in (older files lack some).
  function normalize(s) {
    const d = newSurvey(s.name || "Heatmap");
    const out = { ...d, ...s, apNames: s.apNames || {}, apPlaces: s.apPlaces || {}, apOverrides: s.apOverrides || {}, spots: s.spots || [] };
    if (out.overlay) out.overlay = { rotation: 0, opacity: 0.85, stripped: true, white: false, mapOpacity: 1, ...out.overlay };
    return out;
  }

  /// Centre channel of a wide channel (40/80/160 MHz), for overlap.
  function centre(ch, width, band) {
    if (!(width > 20)) return ch;
    if (band === "6 GHz") { const size = width / 20, start = Math.floor(Math.floor((ch - 1) / 4) / size) * size; return 1 + 4 * start + 2 * (size - 1); }
    if (band === "5 GHz") {
      const blocks = { 40: [[36, 40], [44, 48], [52, 56], [60, 64], [100, 104], [108, 112], [116, 120], [124, 128], [132, 136], [140, 144], [149, 153], [157, 161], [165, 169]],
        80: [[36, 48], [52, 64], [100, 112], [116, 128], [132, 144], [149, 161], [165, 177]], 160: [[36, 64], [100, 128], [149, 177]] };
      const r = (blocks[width] || []).find(([a, b]) => ch >= a && ch <= b);
      if (r) return (r[0] + r[1]) / 2;
    }
    return ch;
  }

  /// Several scans at one spot → one reading per access point (average dBm), strongest first.
  function average(scans) {
    const groups = new Map();
    for (const scan of scans) for (const n of scan) {
      const key = n.bssid ? n.bssid : `${n.ssid}|${n.channel}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    return [...groups.values()].map(list => {
      const last = list[list.length - 1];
      const avg = list.reduce((t, n) => t + n.rssi, 0) / list.length;
      return { ssid: last.ssid, bssid: last.bssid, rssi: Math.round(avg), channel: last.channel, band: last.band, widthMHz: last.widthMHz ?? last.widthMhz ?? 20 };
    }).sort((a, b) => b.rssi - a.rssi);
  }

  /// Two networks share air when their channels overlap in the same band.
  function overlaps(a, b) {
    if (a.band !== b.band || !(a.channel > 0) || !(b.channel > 0)) return false;
    // Channel numbers are 5 MHz apart; 2.4 GHz channels are about 22 MHz wide.
    const wa = a.band === "2.4 GHz" ? Math.max(a.widthMHz, 22) : a.widthMHz;
    const wb = b.band === "2.4 GHz" ? Math.max(b.widthMHz, 22) : b.widthMHz;
    return Math.abs(centre(a.channel, a.widthMHz, a.band) - centre(b.channel, b.widthMHz, b.band)) < (wa + wb) / 10 - 0.01;
  }

  /// Which access point a radio belongs to (the older, simpler key): bytes 2–5 plus the top half of byte 6.
  function apKey(bssid) {
    const parts = String(bssid || "").toUpperCase().split(":");
    const last = parts.length === 6 ? parseInt(parts[5], 16) : NaN;
    if (Number.isNaN(last)) return String(bssid || "").toUpperCase();
    return parts.slice(1, 5).join(":") + ":" + (last >> 4).toString(16).toUpperCase();
  }

  /// Whether two radios are probably the same access point (see the Mac's Heatmap.sameAP).
  function sameAP(a, b) {
    const bytes = s => { const p = String(s).split(":").map(x => parseInt(x, 16)); return p.length === 6 && p.every(n => !Number.isNaN(n)) ? p : null; };
    const x = bytes(a), y = bytes(b);
    if (!x || !y) return false;
    const diff = [0, 1, 2, 3, 4, 5].filter(i => x[i] !== y[i]);
    const last = () => Math.abs(x[5] - y[5]) <= 15 && ((x[5] >> 4) === (y[5] >> 4) || Math.abs(x[5] - y[5]) <= 3);
    const first = () => ((x[0] ^ y[0]) & 0x01) === 0;      // never the multicast bit
    const d = diff.join(",");
    if (d === "") return true;
    if (d === "5") return last();
    if (d === "3" || d === "4") return Math.abs(x[diff[0]] - y[diff[0]]) <= 2;
    if (d === "0") return first();
    if (d === "0,5") return first() && last();
    return false;
  }

  /// Radio (BSSID) → its access point's key: automatic grouping by sameAP, then the hand overrides on top.
  function groups(bssids, overrides = {}) {
    const list = [...new Set([...bssids].map(b => String(b).toUpperCase()))].sort();
    const parent = list.map((_, i) => i);
    const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < list.length; i++) {
      if (overrides[list[i]] != null) continue;
      for (let j = i + 1; j < list.length; j++) {
        if (overrides[list[j]] != null || !sameAP(list[i], list[j])) continue;
        const a = root(i), b = root(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
    const out = {};
    list.forEach((r, i) => { out[r] = overrides[r] ?? apKey(list[root(i)]); });
    return out;
  }
  const groupCache = new Map();
  /// groups() for a survey, remembered until its spots or overrides change.
  function cachedGroups(s) {
    const key = `${s.id}|${s.spots.length}|${s.spots[s.spots.length - 1]?.id || ""}|${JSON.stringify(Object.entries(s.apOverrides || {}).sort())}`;
    if (groupCache.has(key)) return groupCache.get(key);
    const g = groups(s.spots.flatMap(p => p.readings.map(r => r.bssid)).filter(Boolean), s.apOverrides || {});
    if (groupCache.size > 50) groupCache.clear();
    groupCache.set(key, g);
    return g;
  }

  /// The network to show: the chosen one, else the one joined at most spots.
  function shownNetwork(s) {
    if (s.network != null) return s.network === "" ? null : s.network;
    const count = new Map();
    for (const p of s.spots) if (p.joinedSSID) count.set(p.joinedSSID, (count.get(p.joinedSSID) || 0) + 1);
    let best = null;
    for (const [k, v] of count) if (!best || v > best[1]) best = [k, v];
    return best ? best[0] : null;
  }
  /// Every network name heard, most-heard first.
  function networkNames(s) {
    const count = new Map();
    for (const p of s.spots) for (const n of new Set(p.readings.map(r => r.ssid))) if (n) count.set(n, (count.get(n) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(x => x[0]);
  }

  /// The access point a radio belongs to: its name (given here, or from UniFi), else "Network …AB:CD".
  function apName(s, bssid, ssid) {
    const g = cachedGroups(s), names = s.apNames || {};
    const B = String(bssid || "").toUpperCase();
    const key = g[B] ?? apKey(bssid);
    if (names[key]) return names[key];
    if (names[bssid]) return names[bssid];
    // A name given to another radio of the same access point (or under an older grouping) names it too.
    for (const [r, k] of Object.entries(g)) {
      if (k !== key) continue;
      if (names[r]) return names[r];
      if (names[apKey(r)]) return names[apKey(r)];
    }
    // A name given to a radio numbered from this one (heard or not).
    for (const [k, n] of Object.entries(names)) if (k.length === 17 && n && (apKey(k) === apKey(bssid) || sameAP(k, B))) return n;
    const tail = String(bssid || "").split(":").slice(-2).join(":");
    return !bssid ? (ssid ? ssid : "Hidden network") : `${ssid || "AP"} …${tail}`;
  }

  /// "12 ft" from plan pixels, when the scale is set.
  const length = (s, pixels) => s.scale && s.scale.pixelsPerUnit > 0 ? `${Math.round(pixels / s.scale.pixelsPerUnit)} ${s.scale.metres ? "m" : "ft"}` : null;

  /// The value one spot contributes to the map.
  function value(spot, mode, f) {
    const mine = spot.readings.filter(r => matches(f, r));
    const max = list => list.length ? Math.max(...list) : null;
    switch (mode) {
      case "signal": return max(mine.map(r => r.rssi)) ?? silent;
      case "oneAP": {
        if (!f.bssid) return null;
        const radios = f.radios || new Set();
        const one = spot.readings.filter(r => (radios.size ? radios.has(r.bssid.toUpperCase()) : apKey(r.bssid) === f.bssid) && bandMatches(f.band || "all", r.band));
        return max(one.map(r => r.rssi)) ?? silent;
      }
      case "apCount": return mine.filter(r => r.rssi >= -75).length;
      case "overlap": {
        if (!mine.length) return null;
        const best = mine.reduce((a, b) => (b.rssi > a.rssi ? b : a));
        const others = spot.readings.filter(r => r.ssid !== best.ssid && r.rssi >= -82 && overlaps(r, best));
        return new Set(others.map(r => r.ssid || r.bssid)).size;
      }
      case "ping": return spot.pingMs ?? null;
    }
    return null;
  }

  /// 0 (bad) … 1 (good) for a value, by mode.
  function level(v, mode) {
    const ramp = pts => {
      if (v <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) if (v <= pts[i][0]) { const [a, b] = [pts[i - 1], pts[i]]; return a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]); }
      return pts[pts.length - 1][1];
    };
    switch (mode) {
      case "signal": case "oneAP": return ramp([[-85, 0], [-75, 0.25], [-67, 0.5], [-60, 0.75], [-45, 1]]);
      case "apCount": return ramp([[0, 0], [1, 0.33], [2, 0.66], [3, 1]]);
      case "overlap": return ramp([[0, 1], [1, 0.6], [2, 0.33], [3, 0]]);
      case "ping": return ramp([[10, 1], [30, 0.66], [60, 0.33], [100, 0]]);
    }
    return 0;
  }

  /// Red → orange → yellow → green, for a 0…1 level: [r, g, b] in 0…1.
  function color(l) {
    const stops = [[0, [0xE2, 0x46, 0x3C]], [0.25, [0xEF, 0x8A, 0x2B]], [0.5, [0xF1, 0xC2, 0x32]], [0.75, [0x5D, 0xBB, 0x3F]], [1, [0x15, 0x94, 0x47]]];
    l = Math.min(Math.max(l, 0), 1);
    for (let i = 1; i < stops.length; i++) if (l <= stops[i][0]) {
      const [a, b] = [stops[i - 1], stops[i]], t = (l - a[0]) / (b[0] - a[0]);
      return a[1].map((c, k) => (c + (b[1][k] - c) * t) / 255);
    }
    return [0x15 / 255, 0x94 / 255, 0x47 / 255];
  }
  const css = l => { const c = color(l); return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`; };

  /// How far from a measured spot the map still shows a colour (plan pixels): about 35 ft when scaled.
  function reach(s) {
    const longest = Math.max(s.planWidth, s.planHeight);
    if (s.scale && s.scale.pixelsPerUnit > 0) return s.scale.pixelsPerUnit * (s.scale.metres ? 10.5 : 35);
    const pts = s.spots;
    if (pts.length <= 1) return longest * 0.15;
    const nearest = pts.map(p => Math.min(...pts.filter(q => q.id !== p.id).map(q => Math.hypot(q.x - p.x, q.y - p.y)))).sort((a, b) => a - b);
    const median = nearest[Math.floor(nearest.length / 2)];
    return Math.min(Math.max(median * 2.5, longest * 0.12), longest * 0.35);
  }

  /// Inverse-distance blend of the points' values over a grid `cols` wide: {cols, rows, values (null = nothing near), alpha}.
  function gridOf(points, width, height, cols, rch) {
    cols = Math.max(cols, 2);
    const cell = width / cols, rows = Math.max(Math.ceil(height / cell), 2);
    const values = new Array(cols * rows).fill(null), alpha = new Array(cols * rows).fill(0);
    if (!points.length || !(rch > 0)) return { cols, rows, values, alpha };
    const soft = rch * 0.18;
    for (let row = 0; row < rows; row++) {
      const y = (row + 0.5) * cell;
      for (let col = 0; col < cols; col++) {
        const x = (col + 0.5) * cell;
        let sumW = 0, sumV = 0, nearest = Infinity;
        for (const p of points) {
          const d = Math.hypot(p.x - x, p.y - y);
          nearest = Math.min(nearest, d);
          if (d >= rch * 1.5) continue;
          const w = 1 / (d * d + soft * soft);
          sumW += w; sumV += w * p.v;
        }
        if (nearest > rch || sumW <= 0) continue;
        const i = row * cols + col;
        values[i] = sumV / sumW;
        alpha[i] = nearest <= rch * 0.7 ? 1 : Math.max(0, 1 - (nearest - rch * 0.7) / (rch * 0.3));
      }
    }
    return { cols, rows, values, alpha };
  }
  function grid(s, mode, f, cols = 180) {
    const pts = s.spots.map(p => ({ x: p.x, y: p.y, v: value(p, mode, f) })).filter(p => p.v != null);
    return gridOf(pts, s.planWidth, s.planHeight, cols, reach(s));
  }

  /// Share of the measured area that's good (−67 or better), fair (to −75) and poor.
  function coverage(g) {
    let good = 0, fair = 0, poor = 0;
    g.values.forEach((v, i) => { if (v == null || g.alpha[i] <= 0.5) return; if (v >= -67) good++; else if (v >= -75) fair++; else poor++; });
    const total = good + fair + poor;
    return total ? { good: good / total, fair: fair / total, poor: poor / total, measured: true } : { good: 0, fair: 0, poor: 0, measured: false };
  }

  /// An access point's loudest reading per band.
  function bandBest(spots, radios, f) {
    const best = new Map();
    for (const s of spots) for (const r of s.readings) {
      if (!radios.has(r.bssid.toUpperCase()) || !matches(f, r)) continue;
      const b = best.get(r.band);
      if (b && b.rssi >= r.rssi) continue;
      best.set(r.band, r);
    }
    return [...best.values()].sort((a, b) => a.band.localeCompare(b.band));
  }

  /// The access points heard on the network and band: one per AP (its radios grouped), loudest first.
  function accessPoints(spots, f, placed = {}, overrides = {}) {
    const g = groups(spots.flatMap(s => s.readings.map(r => r.bssid)).filter(Boolean), overrides);
    const heard = new Map(), radios = new Map();
    for (const s of spots) for (const r of s.readings) {
      if (!matches(f, r) || !r.bssid) continue;
      const key = g[r.bssid.toUpperCase()] ?? apKey(r.bssid);
      if (!radios.has(key)) radios.set(key, new Set());
      radios.get(key).add(r.bssid.toUpperCase());
      if (!heard.has(key)) heard.set(key, new Map());
      const have = heard.get(key).get(s.id);
      if (have && have.r.rssi >= r.rssi) continue;
      heard.get(key).set(s.id, { spot: s, r });
    }
    const out = [];
    for (const [key, bySpot] of heard) {
      const list = [...bySpot.values()];
      if (!list.length) continue;
      const loudest = list.reduce((a, b) => (b.r.rssi > a.r.rssi ? b : a));
      const top = [...list].sort((a, b) => b.r.rssi - a.r.rssi).slice(0, 3);
      const w = top.map(t => Math.pow(10, t.r.rssi / 10)), total = w.reduce((a, b) => a + b, 0);
      let x = top.reduce((t, p, i) => t + p.spot.x * w[i], 0) / total, y = top.reduce((t, p, i) => t + p.spot.y * w[i], 0) / total;
      const mine = radios.get(key) || new Set();
      // A position placed under an earlier grouping still counts.
      let place = placed[key];
      if (!place) for (const m of mine) { place = placed[apKey(m)] || placed[m]; if (place) break; }
      if (place) { x = place.x; y = place.y; }
      const bands = [...new Set(spots.flatMap(s => s.readings).filter(r => mine.has(r.bssid.toUpperCase()) && matches(f, r)).map(r => r.band))].sort();
      const ap = { key, bssid: loudest.r.bssid, ssid: loudest.r.ssid, channel: loudest.r.channel, band: loudest.r.band, widthMHz: loudest.r.widthMHz,
        best: loudest.r.rssi, spotsHeard: list.length, x, y, placed: !!place, radios: mine.size, bands, radioList: [...mine].sort(),
        bandReadings: bandBest(spots, mine, f) };
      ap.worthShowing = ap.placed || ap.spotsHeard >= 3;
      out.push(ap);
    }
    return out.sort((a, b) => b.best - a.best || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /// Pairs of access points that share a channel on a band and were both strong (−70 or better) at the same spots.
  function channelClashes(aps, spots, strong = -70) {
    const out = [];
    const loudest = (ap, band, s) => {
      const radios = new Set(ap.radioList.length ? ap.radioList : [ap.bssid.toUpperCase()]);
      const v = s.readings.filter(r => r.band === band && radios.has(r.bssid.toUpperCase())).map(r => r.rssi);
      return v.length ? Math.max(...v) : null;
    };
    aps.forEach((x, i) => {
      for (const y of aps.slice(i + 1)) for (const rx of x.bandReadings) for (const ry of y.bandReadings) {
        if (!overlaps(rx, ry)) continue;
        const together = spots.filter(s => (loudest(x, rx.band, s) ?? -200) >= strong && (loudest(y, ry.band, s) ?? -200) >= strong).length;
        if (!together) continue;
        const c = { a: x.key, b: y.key, band: rx.band, channelA: rx.channel, channelB: ry.channel, spots: together };
        c.label = c.channelA === c.channelB ? `ch ${c.channelA}` : `ch ${c.channelA} and ${c.channelB}`;
        out.push(c);
      }
    });
    return out;
  }

  /// Plan pixels per foot (or metre) for a plan that's `metresWide` across in real life.
  const pixelsPerUnit = (planWidth, metresWide, metres) => planWidth / (metres ? metresWide : metresWide * 3.280839895);

  /// UniFi access points on a network map, by access point key.
  function uniFiNames(map, g = {}) {
    const out = {};
    if (!map) return out;
    for (const n of map.nodes || []) {
      if (n.kind !== "ap" || !n.mac || !n.name) continue;
      const m = NetMapBuilder.mac(n.mac);
      out[apKey(m)] = n.name;
      for (const [bssid, key] of Object.entries(g)) if (bssid === m || sameAP(bssid, m)) out[key] = n.name;
    }
    return out;
  }

  /// Networks heard that aren't the chosen one.
  function neighborCount(spots, f) {
    if (f.ssid == null) return 0;
    return new Set(spots.flatMap(s => s.readings.filter(r => r.ssid !== f.ssid && bandMatches(f.band || "all", r.band)).map(r => r.bssid || r.ssid))).size;
  }

  const minus = s => String(s).replace(/-/g, "−");
  /// Plain-language notes about the map: [{level: good|warn|bad|info, text, spot}].
  function findings(s, f, cov) {
    const out = [], spots = s.spots;
    if (spots.length < 5) out.push({ level: "info", text: "Measure at least 5 spots, about every 10–15 ft, for a useful map." });
    if (!spots.length) return out;
    const signal = spots.map(p => [p, value(p, "signal", f) ?? silent]);
    const weakest = signal.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (weakest[1] < -75) {
      const dBm = weakest[1] <= silent ? "nothing heard" : `${minus(Math.trunc(weakest[1]))} dBm`;
      let text = `Weakest spot: ${dBm} (marked on the map).`;
      if (cov.poor >= 0.05) text = `${Math.round(cov.poor * 100)}% of the measured area is below −75 dBm. ` + text;
      out.push({ level: "bad", text, spot: weakest[0].id });
    } else if (spots.length >= 5) {
      out.push({ level: "good", text: "Every spot measured −75 dBm or better" + (signal.every(x => x[1] >= -67) ? ", and all are −67 or better." : ".") });
    }
    const ssid = f.ssid;
    if (ssid == null) return out;
    const aps = accessPoints(spots, { ssid, band: f.band }, {}, s.apOverrides || {});
    const g = cachedGroups(s), groupOf = b => g[b.toUpperCase()] ?? apKey(b);
    // Neighbors on an own AP's channel, heard where that AP is useful.
    for (const ap of aps) {
      const r = { ssid: ap.ssid, bssid: ap.bssid, rssi: ap.best, channel: ap.channel, band: ap.band, widthMHz: ap.widthMHz };
      const neighbors = new Set();
      for (const p of spots) {
        if (!p.readings.some(x => x.bssid === ap.bssid && x.rssi >= -75)) continue;
        for (const n of p.readings) if (n.ssid !== ssid && n.rssi >= -82 && overlaps(n, r)) neighbors.add(n.ssid || n.bssid);
      }
      if (neighbors.size >= 2) out.push({ level: "warn", text: `${apName(s, ap.bssid, ap.ssid)} shares channel ${ap.channel} with ${neighbors.size} neighbor networks.` });
    }
    // Own APs on the same channel, both strong at one spot.
    const pairs = new Set();
    for (const p of spots) {
      const strong = p.readings.filter(x => x.ssid === ssid && x.rssi >= -72 && bandMatches(f.band || "all", x.band));
      strong.forEach((a, i) => {
        for (const b of strong.slice(i + 1)) {
          if (groupOf(a.bssid) === groupOf(b.bssid) || !overlaps(a, b)) continue;
          const key = [groupOf(a.bssid), groupOf(b.bssid)].sort().join("|");
          if (pairs.has(key)) continue;
          pairs.add(key);
          out.push({ level: "warn", text: `${apName(s, a.bssid, a.ssid)} and ${apName(s, b.bssid, b.ssid)} are both on channel ${a.channel} and loud in the same place.` });
        }
      });
    }
    return out;
  }

  /// A table of the spots, for Save to Organization (kind "heatmap", linked to this heatmap).
  function draft(s, f, cov) {
    if (!s.spots.length) return null;
    const when = iso => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return ""; } };
    const rows = s.spots.map((p, i) => {
      const mine = p.readings.filter(r => matches(f, r)), best = mine[0];
      const place = s.scale ? `${Math.round(p.x / s.scale.pixelsPerUnit)}, ${Math.round(p.y / s.scale.pixelsPerUnit)} ${s.scale.metres ? "m" : "ft"}` : `${Math.trunc(p.x)}, ${Math.trunc(p.y)} px`;
      return [String(i + 1), place, best ? apName(s, best.bssid, best.ssid) : "", best ? String(best.rssi) : "", best ? `${best.channel} · ${best.band}` : "",
        String(mine.filter(r => r.rssi >= -75).length), String(p.readings.length), p.pingMs != null ? p.pingMs.toFixed(0) : "", when(p.date)];
    });
    let summary = `${s.spots.length} spots`;
    if (cov.measured) summary += ` · ${Math.round(cov.good * 100)}% good, ${Math.round(cov.fair * 100)}% fair, ${Math.round(cov.poor * 100)}% poor`;
    if (f.ssid) summary += ` · ${f.ssid}`;
    return { kind: "heatmap", title: `Wi-Fi heatmap · ${s.name}`, summary, heatmapID: s.id,
      table: { header: ["Spot", "Where", "Best AP", "Signal dBm", "Channel", "APs at −75+", "Networks heard", "Ping ms", "When"], rows,
        widths: [6, 14, 26, 11, 14, 12, 15, 9, 20], numberColumns: [0, 3, 5, 6, 7] } };
  }

  /// A new plan picture of another size: spots and scale move with it.
  function rescale(s, w, h) {
    const fx = w / s.planWidth, fy = h / s.planHeight;
    for (const p of s.spots) { p.x *= fx; p.y *= fy; }
    if (s.scale) s.scale = { ...s.scale, pixelsPerUnit: s.scale.pixelsPerUnit * (fx + fy) / 2 };
    s.planWidth = w; s.planHeight = h;
  }

  /// Where the plan sits at a zoom: scale (screen px per plan px), corner, and the scrolling area's size.
  function layout(plan, viewport, zoom) {
    if (!(plan.width > 0 && plan.height > 0 && viewport.width > 0 && viewport.height > 0)) return { origin: { x: 0, y: 0 }, k: 1, size: viewport };
    const k = Math.min(viewport.width / plan.width, viewport.height / plan.height) * zoom;
    const w = plan.width * k, h = plan.height * k;
    const size = { width: Math.max(viewport.width, w), height: Math.max(viewport.height, h) };
    return { origin: { x: (size.width - w) / 2, y: (size.height - h) / 2 }, k, size };
  }

  /// A floor plan with its paper removed, on RGBA pixels (in place): white and near-white (and light grey, unless
  /// coloured) becomes clear, with a soft edge. Not premultiplied (canvas ImageData).
  function stripBackground(px) {
    for (let p = 0; p < px.length; p += 4) {
      const a = px[p + 3]; if (!a) continue;
      const R = px[p] / 255, G = px[p + 1] / 255, B = px[p + 2] / 255;
      const hi = Math.max(R, G, B), lo = Math.min(R, G, B), sat = hi > 0 ? (hi - lo) / hi : 0;
      if (sat >= 0.18) continue;
      // Brightness 0.80 and below stays; 0.93 and above goes; in between fades.
      const keep = Math.min(1, Math.max(0, (0.93 - hi) / 0.13));
      px[p + 3] = Math.round(a * keep);
    }
    return px;
  }
  /// Every line white (see-through parts stay see-through), in place.
  function whitened(px) { for (let p = 0; p < px.length; p += 4) { px[p] = px[p + 1] = px[p + 2] = 255; } return px; }
  /// −180…180.
  const wrap = d => { d = d % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };

  return { silent, blankSize, isSignal, bandMatches, matches, newId, newSurvey, normalize, centre, average, overlaps, apKey, sameAP, groups, cachedGroups,
    shownNetwork, networkNames, apName, length, value, level, color, css, reach, gridOf, grid, coverage, bandBest, accessPoints, channelClashes,
    pixelsPerUnit, uniFiNames, neighborCount, findings, draft, rescale, layout, stripBackground, whitened, wrap };
})();
