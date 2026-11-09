// DNS Lookup's extra tabs (Email Check, Compare Servers, Expiry, Reverse Subnet) and the bigger "All" host list.
// The checks themselves, without any screen, so the DNS window and the site survey share them.
"use strict";

/// Common host names "All" asks for (A records; any CNAME they point through shows too).
const DNS_COMMON_HOSTS = [
  "www", "mail", "webmail", "owa", "smtp", "imap", "pop", "mx", "mx1", "mx2", "autodiscover", "autoconfig", "lyncdiscover", "sip",
  "enterpriseregistration", "enterpriseenrollment", "msoid", "remote", "vpn", "vpn2", "ras", "rdweb", "rdgateway", "rdp", "ts", "citrix",
  "gateway", "fw", "firewall", "portal", "intranet", "extranet", "exchange", "ftp", "sftp", "files", "share", "nas", "ns1", "ns2", "ns3",
  "mta-sts", "sso", "login", "auth", "adfs", "sts", "id", "account", "accounts", "admin", "api", "app", "apps", "cloud", "cdn", "static",
  "assets", "images", "img", "media", "m", "mobile", "blog", "shop", "store", "support", "help", "helpdesk", "ticket", "status", "docs",
  "dev", "test", "staging", "beta", "demo", "crm", "erp", "hr", "payroll", "calendar", "meet", "teams", "voip", "pbx", "phone", "print",
  "backup", "monitor", "dashboard", "cpanel", "webdisk", "whm", "secure", "cp",
];

const dnsq = (name, kind, server) => window.__TAURI__.core.invoke("dns_lookup", { name, kind, server: server || "" });
const own = (answers, name, type) => answers.filter(a => a.type === type && a.name.toLowerCase().replace(/\.$/, "") === name.toLowerCase().replace(/\.$/, ""));
const txtText = a => a.data.replace(/^"|"$/g, "").replace(/" "/g, "");
/// Runs `fn` on every item, `n` at a time, keeping the order.
async function inParallel(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; } }
  }));
  return out;
}

// MARK: Email Check

const DKIM_SELECTORS = ["selector1", "selector2", "google", "k1", "k2", "k3", "default", "s1", "s2", "dkim", "mail", "smtp", "mandrill", "mxvault", "everlytickey1", "zoho", "protonmail"];

/// SPF: follows include: and redirect= and counts the DNS lookups (the limit is 10).
async function spfLookups(record, server, seen = new Set(), depth = 0) {
  let count = 0;
  const terms = record.split(/\s+/).slice(1);
  for (const t of terms) {
    const m = /^[+~?-]?(include|a|mx|ptr|exists|redirect)(?:[:=](.+))?$/i.exec(t);
    if (!m) continue;
    count++;
    const mech = m[1].toLowerCase(), target = (m[2] || "").replace(/\.$/, "");
    if ((mech === "include" || mech === "redirect") && target && !seen.has(target) && depth < 10) {
      seen.add(target);
      try {
        const r = await dnsq(target, "TXT", server);
        const spf = own(r.answers, target, "TXT").map(txtText).find(x => /^v=spf1\b/i.test(x));
        if (spf) count += await spfLookups(spf, server, seen, depth + 1);
      } catch {}
    }
  }
  return count;
}

/// One verdict per email-security record. state: good, warn, bad, info.
async function emailCheck(domain, server) {
  const d = domain.trim().replace(/^\.+|\.+$/g, "").toLowerCase();
  const rows = [];
  const add = (state, check, text, detail = "") => rows.push({ state, check, text, detail });
  const q = async (n, t) => { try { return (await dnsq(n, t, server)).answers; } catch { return []; } };
  // The independent questions all go out at once; the checks below read them in order.
  const asked = new Map();
  const ask = (n, t) => { const k = `${n}|${t}`; if (!asked.has(k)) asked.set(k, q(n, t)); return asked.get(k); };
  for (const [n, t] of [[d, "MX"], [d, "TXT"], [`_dmarc.${d}`, "TXT"], [`_mta-sts.${d}`, "TXT"], [`_smtp._tls.${d}`, "TXT"], [`default._bimi.${d}`, "TXT"], [d, "DS"]]) ask(n, t);

  // MX, and whether each mail server's address points back to its name.
  const mx = own(await ask(d, "MX"), d, "MX").map(a => { const [pref, host] = a.data.split(/\s+/); return { pref: Number(pref), host: (host || "").replace(/\.$/, "") }; }).sort((a, b) => a.pref - b.pref);
  if (!mx.length) add("bad", "MX", "No mail servers (MX records): this domain can’t receive email.");
  else {
    const checks = await inParallel(mx, 4, async m => {
      const ips = (await q(m.host, "A")).filter(a => a.type === "A").map(a => a.data);
      if (!ips.length) return `${m.host}: no address`;
      const ptr = (await q(ips[0], "PTR")).filter(a => a.type === "PTR").map(a => a.data.replace(/\.$/, "").toLowerCase());
      if (!ptr.length) return `${m.host} (${ips[0]}): no reverse name`;
      return null;
    });
    const problems = checks.filter(Boolean);
    add(problems.length ? "warn" : "good", "MX", `${mx.length} mail server${mx.length === 1 ? "" : "s"}: ${mx.map(m => `${m.host} (${m.pref})`).join(", ")}.`,
      problems.length ? problems.join("; ") + ". Other servers may distrust mail from an address without a reverse name." : "All have addresses with reverse names.");
  }

  // SPF
  const spfs = own(await ask(d, "TXT"), d, "TXT").map(txtText).filter(x => /^v=spf1\b/i.test(x));
  if (!spfs.length) add("bad", "SPF", "No SPF record: anyone can send mail claiming to be from this domain.", "Add a TXT record starting v=spf1 that lists your mail services.");
  else if (spfs.length > 1) add("bad", "SPF", "More than one SPF record. Only one is allowed, so receivers treat SPF as broken.", spfs.join("\n"));
  else {
    const spf = spfs[0];
    const n = await spfLookups(spf, server);
    const all = (/\s([+~?-]?)all\b/i.exec(spf) || [])[1];
    const notes = [`${n} of 10 DNS lookups used${n > 10 ? " (over the limit: receivers treat SPF as broken)" : n >= 8 ? " (close to the limit)" : ""}.`];
    let state = n > 10 ? "bad" : n >= 8 ? "warn" : "good";
    if (all === undefined) { notes.push("No “all” at the end, so mail from other servers isn’t covered."); if (state === "good") state = "warn"; }
    else if (all === "" || all === "+") { notes.push("Ends in +all: allows any server to send as this domain."); state = "bad"; }
    else if (all === "?") { notes.push("Ends in ?all (neutral): says nothing about other servers."); if (state === "good") state = "warn"; }
    else if (all === "~") notes.push("Ends in ~all (soft fail): mail from other servers is marked, not refused.");
    else notes.push("Ends in -all: mail from other servers is refused.");
    add(state, "SPF", spf, notes.join(" "));
  }

  // DMARC
  const dmarc = own(await ask(`_dmarc.${d}`, "TXT"), `_dmarc.${d}`, "TXT").map(txtText).find(x => /^v=DMARC1/i.test(x));
  if (!dmarc) add("bad", "DMARC", "No DMARC record: nothing tells receivers what to do with mail that fails SPF and DKIM.", "Start with v=DMARC1; p=none; rua=mailto:… to collect reports, then tighten it.");
  else {
    const tag = k => ((new RegExp(`(?:^|;)\\s*${k}=([^;]+)`, "i").exec(dmarc) || [])[1] || "").trim();
    const p = tag("p").toLowerCase(), pct = tag("pct"), rua = tag("rua");
    const extra = [rua ? `Reports go to ${rua}.` : "No report address (rua), so nobody sees the results.", pct && pct !== "100" ? `Only ${pct}% of failing mail is affected (pct).` : ""].filter(Boolean).join(" ");
    if (p === "reject") add(pct && pct !== "100" ? "warn" : "good", "DMARC", "p=reject: mail that fails SPF and DKIM is refused.", extra);
    else if (p === "quarantine") add(pct && pct !== "100" ? "warn" : "good", "DMARC", "p=quarantine: mail that fails SPF and DKIM goes to junk.", extra);
    else add("bad", "DMARC", "p=none: reports only. Mail that fails SPF and DKIM is still delivered. Move to p=quarantine, then p=reject, once reports look clean.", extra);
  }

  // DKIM (only the usual selector names can be checked; a domain may use others)
  const found = (await inParallel(DKIM_SELECTORS, 8, async s => {
    const n = `${s}._domainkey.${d}`;
    const a = await q(n, "TXT");
    return a.some(x => x.type === "TXT" && /v=DKIM1|k=rsa|p=/i.test(txtText(x))) || a.some(x => x.type === "CNAME") ? s : null;
  })).filter(Boolean);
  const vendor = found.includes("selector1") || found.includes("selector2") ? " (Microsoft 365)" : found.includes("google") ? " (Google Workspace)" : "";
  if (found.length) add("good", "DKIM", `Found ${found.join(" and ")}${vendor}.`);
  else add("warn", "DKIM", "None of the usual selector names found.", "DKIM may still be set up under another name; check the mail service’s settings.");

  // MTA-STS, TLS reports, BIMI
  const one = async (n, re) => own(await ask(n, "TXT"), n, "TXT").map(txtText).find(x => re.test(x));
  const sts = await one(`_mta-sts.${d}`, /^v=STSv1/i);
  add(sts ? "good" : "warn", "MTA-STS", sts ? sts : "Not set up. Optional: makes other servers use encryption when sending to you.");
  const tls = await one(`_smtp._tls.${d}`, /^v=TLSRPTv1/i);
  add(tls ? "good" : "warn", "TLS reports", tls ? tls.replace(/^v=TLSRPTv1;\s*/i, "") : "Not set up. Optional: reports when other servers can’t deliver securely.");
  const bimi = await one(`default._bimi.${d}`, /^v=BIMI1/i);
  add("info", "BIMI", bimi ? bimi : "Not set up (optional: shows your logo in some mail apps).");

  // DNSSEC
  const ds = (await ask(d, "DS")).filter(a => a.type === "DS");
  add(ds.length ? "good" : "info", "DNSSEC", ds.length ? "Signed (DS record at the registry)." : "Not signed (most domains aren’t). Shown for information only.");
  return rows;
}

// MARK: Compare Servers

/// The zone a name lives in and its own name servers: walks up the name until a level has NS records.
async function ownNameServers(name, server) {
  const labels = name.trim().replace(/\.$/, "").toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = labels.slice(i).join(".");
    try {
      const ns = own((await dnsq(zone, "NS", server)).answers, zone, "NS").map(a => a.data.replace(/\.$/, ""));
      if (ns.length) return { zone, ns: ns.sort() };
    } catch {}
  }
  return { zone: "", ns: [] };
}

/// servers: [{label, server}] (server "" = this PC's DNS). Returns rows plus whether the answers differ.
async function compareServers(name, type, servers) {
  const rows = await inParallel(servers, 8, async s => {
    try {
      const r = await dnsq(name, type, s.server);
      const ans = r.answers.filter(a => a.type === type);
      // A domain's own name servers often answer an alias with just the CNAME (the rest lives elsewhere):
      // show where it points, but don't count it as a different answer.
      const cname = r.answers.find(a => a.type === "CNAME" && type !== "CNAME");
      if (!ans.length && cname) return { ...s, answer: `→ alias for ${cname.data.replace(/\.$/, "")}`, ttl: cname.ttl, ms: r.ms, failed: false, aliasOnly: true };
      return { ...s, answer: ans.map(a => a.data).sort().join("\n") || (r.status ? r.status : "(no answer)"), ttl: ans.length ? Math.min(...ans.map(a => a.ttl)) : null, ms: r.ms, failed: false };
    } catch (e) { return { ...s, answer: String(e), ttl: null, ms: null, failed: true }; }
  });
  const ok = rows.filter(r => !r.failed && !r.aliasOnly);
  const counts = new Map(); ok.forEach(r => counts.set(r.answer, (counts.get(r.answer) || 0) + 1));
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  rows.forEach(r => (r.different = !r.failed && !r.aliasOnly && r.answer !== usual));
  return { rows, differ: counts.size > 1, usual };
}

/// Whether the domain's own name servers agree (same SOA serial).
async function soaSerials(zone, nsList) {
  return inParallel(nsList, 6, async ns => {
    try { const s = own((await dnsq(zone, "SOA", ns)).answers, zone, "SOA")[0]; return { ns, serial: s ? s.data.split(/\s+/)[2] : "(no answer)" }; }
    catch { return { ns, serial: "(no answer)" }; }
  });
}

// MARK: Expiry

const EXPIRY_HOSTS = ["", "www", "mail", "autodiscover", "remote", "vpn", "portal", "owa", "webmail", "sso"];
const daysLeft = iso => iso ? Math.floor((Date.parse(iso) - Date.now()) / 86400000) : null;

/// Registration (RDAP) and the HTTPS certificate on each of the domain's usual hosts that exists.
async function expiryCheck(domain, server) {
  const d = domain.trim().replace(/^\.+|\.+$/g, "").toLowerCase();
  const inv = window.__TAURI__.core.invoke;
  const regP = inv("rdap_lookup", { domain: d }).then(r => ({ ok: true, r })).catch(e => ({ ok: false, error: String(e) }));
  const hosts = EXPIRY_HOSTS.map(h => (h ? `${h}.${d}` : d));
  const exists = await inParallel(hosts, 8, async h => { try { return (await dnsq(h, "A", server)).answers.some(a => a.type === "A" || a.type === "CNAME"); } catch { return false; } });
  const live = hosts.filter((_, i) => exists[i]);
  const certs = await inParallel(live, 6, async h => {
    let c = await inv("cert_check", { host: h, port: 443 });
    if (!c.expires && /^(remote|vpn)\./.test(h)) for (const p of [4443, 8443]) { const c2 = await inv("cert_check", { host: h, port: p }); if (c2.expires) { c = c2; break; } }
    return c;
  });
  return { reg: await regP, certs: certs.filter(Boolean) };
}

function expiryRows(res) {
  const fmt = iso => iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
  const rows = [];
  if (res.reg.ok) {
    const r = res.reg.r;
    rows.push(["Domain registration", r.expires ? `${fmt(r.expires)} (${daysLeft(r.expires)} days)` : "unknown", r.registrar, r.nameServers.join(", ") + (r.dnssec != null ? ` · DNSSEC ${r.dnssec ? "signed" : "not signed"}` : "")]);
  } else rows.push(["Domain registration", "", "", res.reg.error]);
  for (const c of res.certs) {
    const d = daysLeft(c.expires);
    rows.push([`${c.host}${c.port !== 443 ? ":" + c.port : ""}`, c.expires ? `${fmt(c.expires)} (${d < 0 ? "expired" : d + " days"})` : c.problem, c.issuer,
      c.expires ? (c.coversHost ? "" : "DOESN’T COVER THIS NAME · ") + (c.names.length > 3 ? `${c.names.slice(0, 3).join(", ")} and ${c.names.length - 3} more` : c.names.join(", ")) : ""]);
  }
  return rows;
}

// MARK: Reverse Subnet

/// PTR names for every address in a range (at most 4,096), 32 at a time.
/// Every address in a range (up to 4,096) and its name: one PTR question each, all sent from one UDP socket by the
/// Rust side (reverse_subnet). Falls back to asking one at a time, 16 at once, when that isn't available.
async function reverseSubnet(range, server, onProgress, live = () => true) {
  const inv = window.__TAURI__.core.invoke;
  try {
    const list = await inv("reverse_subnet", { range, server });
    return list.map(([ip, name]) => ({ ip, name: (name || "").replace(/\.$/, "") }));
  } catch (e) {
    if (!/unknown|not found|reverse_subnet/i.test(String(e))) throw e;
  }
  const spans = await inv("parse_range", { text: range });
  const ips = [];
  for (const [lo, hi] of spans) for (let n = lo; n <= hi && ips.length < 4096; n++) ips.push([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  let done = 0;
  const names = await inParallel(ips, 16, async ip => {
    if (!live()) return "";
    const r = await dnsq(ip, "PTR", server).catch(() => null);
    done++; if (done % 32 === 0) onProgress?.(done, ips.length);
    return r ? r.answers.filter(a => a.type === "PTR").map(a => a.data.replace(/\.$/, "")).join(", ") : "";
  });
  return ips.map((ip, i) => ({ ip, name: names[i] || "" }));
}
