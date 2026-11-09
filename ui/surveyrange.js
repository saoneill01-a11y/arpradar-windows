// What a site survey's network scan should cover (same rules as the Mac's SurveyRange).
"use strict";
const SurveyRange = (() => {
  const ip = t => {
    const p = String(t).trim().split(".");
    if (p.length !== 4 || !p.every(o => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return null;
    return p.reduce((v, o) => v * 256 + Number(o), 0);
  };
  const str = v => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
  /// "10.0.0.0/24", "10.0.0.5", "10.0.0.1-254", "10.0.0.1-10.0.1.9" -> [lo, hi], else null.
  const bounds = t => {
    t = String(t).trim();
    let m = t.match(/^([\d.]+)\/(\d{1,2})$/);
    if (m) { const a = ip(m[1]), b = Number(m[2]); if (a === null || b > 32) return null; const size = 2 ** (32 - b); const lo = a - (a % size); return [lo, lo + size - 1]; }
    m = t.match(/^([\d.]+)-([\d.]+)$/);
    if (m) {
      const a = ip(m[1]); if (a === null) return null;
      const b = /^\d{1,3}$/.test(m[2]) && Number(m[2]) <= 255 ? a - (a % 256) + Number(m[2]) : ip(m[2]);
      return b === null || b < a ? null : [a, b];
    }
    const a = ip(t); return a === null ? null : [a, a];
  };
  /// This PC's network when the organization's DHCP range (or else its name server) is on it, or when neither is
  /// known. Otherwise the organization's own network: its DHCP range when that's a subnet like 10.0.0.0/24, else the
  /// /24 around the DHCP range's first address or the name server (a survey run from somewhere else, e.g. over a VPN).
  function suggested(thisNetwork, dhcpRange, nameServer) {
    const dhcp = String(dhcpRange || "").trim();
    const tokens = dhcp.split(/[\s,;]+/).filter(Boolean);
    const spans = tokens.map(bounds);
    const hint = tokens.length && spans.every(Boolean) ? spans[0][0] : ip(nameServer || "");
    if (hint === null) return thisNetwork;
    const here = bounds(thisNetwork || "");
    if (here && hint >= here[0] && hint <= here[1]) return thisNetwork;
    const m = tokens.length === 1 && dhcp.match(/\/(\d{1,2})$/);
    if (m && Number(m[1]) >= 16) return dhcp;
    return `${str(hint - (hint % 256))}/24`;
  }
  return { suggested, bounds };
})();
if (typeof module !== "undefined") module.exports = { SurveyRange };
