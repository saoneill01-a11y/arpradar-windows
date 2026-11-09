// Appearance shared by every ARPradar window: Auto/Light/Dark, theme, row height and text size (Settings › Appearance).
// Settings live in this app's localStorage; windows follow changes made in another window.
"use strict";
(function () {
  const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    const look = get("appearance", "dark");
    const root = document.documentElement;
    root.dataset.look = look;
    root.dataset.dark = look === "dark" || (look === "auto" && media.matches) ? "1" : "0";
    root.dataset.theme = get("theme", "radar");
    root.dataset.density = get("rowDensity", "regular");
    root.dataset.size = get("textSize", "medium");
  }
  window.applyLook = apply;
  apply();
  media.addEventListener("change", apply);
  window.addEventListener("storage", apply);
  window.__TAURI__?.event?.listen("settings-changed", apply);
})();
