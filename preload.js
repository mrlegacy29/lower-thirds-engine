/* ============================================================================
   Lower Thirds Engine — preload
   ----------------------------------------------------------------------------
   Runs in the renderer with context isolation. It does two things:
     1) Exposes a tiny safe API on window.ltDesktop (version + update controls).
     2) Injects an "Update available" banner directly into the page DOM, so the
        app HTML (lt.html) needs no changes and the same file still works in a
        plain browser / OBS where there is no updater.
   ========================================================================== */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ltDesktop", {
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke("app:info"),
  checkForUpdates: () => ipcRenderer.send("updater:check"),
  installUpdate: () => ipcRenderer.send("updater:install"),
  onUpdate: (cb) => ipcRenderer.on("updater:status", (_e, s) => { try { cb(s); } catch (e) {} }),
});

/* ---------------- update banner (injected, dark, top-center) ---------------- */
let bannerEl = null, textEl = null, btnEl = null, dismissed = "";

// Never inject UI on the OBS Output layer — it would composite on-air.
const IS_OUTPUT = /(^|[?&])view=output/.test(location.search) || /(^|#)output/.test(location.hash) || /\/output\/?$/.test(location.pathname);

function injectBanner() {
  if (IS_OUTPUT) return;
  if (document.getElementById("lt-upd")) return;
  const css = document.createElement("style");
  css.textContent = `
    #lt-upd{position:fixed;top:0;left:50%;transform:translate(-50%,-120%);z-index:2147483647;
      display:flex;align-items:center;gap:12px;max-width:92vw;
      font-family:'Inter',system-ui,Segoe UI,Roboto,Arial,sans-serif;font-size:13px;color:#eef3fb;
      background:linear-gradient(180deg,#16203a,#101830);border:1px solid #2b3a5e;border-top:none;
      border-radius:0 0 12px 12px;padding:10px 14px;box-shadow:0 10px 34px rgba(0,0,0,.5);
      transition:transform .35s cubic-bezier(.2,.9,.3,1)}
    #lt-upd.show{transform:translate(-50%,0)}
    #lt-upd .dot{width:9px;height:9px;border-radius:50%;background:#ffb02e;box-shadow:0 0 10px #ffb02e;flex:0 0 auto}
    #lt-upd.ready .dot{background:#36d07a;box-shadow:0 0 10px #36d07a}
    #lt-upd.err .dot{background:#ff5b52;box-shadow:0 0 10px #ff5b52}
    #lt-upd b{font-weight:700}
    #lt-upd .btn{appearance:none;border:none;cursor:pointer;font-weight:700;font-size:12px;
      color:#06210f;background:linear-gradient(180deg,#48e08a,#1fa85a);padding:6px 12px;border-radius:8px}
    #lt-upd .btn:hover{filter:brightness(1.06)}
    #lt-upd .x{appearance:none;border:none;background:transparent;color:#9fb0cc;cursor:pointer;
      font-size:16px;line-height:1;padding:2px 4px;margin-left:2px}
    #lt-upd .x:hover{color:#eef3fb}
    #lt-upd .bar{position:relative;width:120px;height:6px;border-radius:99px;background:#0c1428;overflow:hidden}
    #lt-upd .bar > i{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,#48e08a,#ffb02e);transition:width .2s}
  `;
  document.head.appendChild(css);

  bannerEl = document.createElement("div");
  bannerEl.id = "lt-upd";
  const dot = document.createElement("span"); dot.className = "dot";
  textEl = document.createElement("span"); textEl.className = "txt";
  const barWrap = document.createElement("span"); barWrap.className = "bar"; barWrap.style.display = "none";
  const bar = document.createElement("i"); barWrap.appendChild(bar);
  btnEl = document.createElement("button"); btnEl.className = "btn"; btnEl.style.display = "none";
  btnEl.textContent = "Restart & Install";
  btnEl.addEventListener("click", () => ipcRenderer.send("updater:install"));
  const x = document.createElement("button"); x.className = "x"; x.innerHTML = "&times;"; x.title = "Dismiss";
  x.addEventListener("click", () => { dismissed = bannerEl.dataset.key || "1"; hide(); });

  bannerEl.append(dot, textEl, barWrap, btnEl, x);
  bannerEl._bar = bar; bannerEl._barWrap = barWrap;
  document.body.appendChild(bannerEl);
}

function show() { if (bannerEl) requestAnimationFrame(() => bannerEl.classList.add("show")); }
function hide() { if (bannerEl) bannerEl.classList.remove("show"); }

function render(s) {
  if (!bannerEl) return;
  s = s || {};
  bannerEl.classList.remove("ready", "err");
  bannerEl._barWrap.style.display = "none";
  btnEl.style.display = "none";

  if (s.status === "available" || s.status === "downloading") {
    const key = "dl:" + (s.newVersion || "");
    bannerEl.dataset.key = key; if (dismissed === key) return;
    if (s.status === "downloading") {
      bannerEl._barWrap.style.display = "";
      bannerEl._bar.style.width = (s.percent || 0) + "%";
      textEl.innerHTML = "<b>Update downloading\u2026</b> " + (s.percent || 0) + "%";
    } else {
      textEl.innerHTML = "<b>Update available</b>" + (s.newVersion ? " (v" + s.newVersion + ")" : "") + " \u2014 downloading\u2026";
    }
    show();
  } else if (s.status === "ready") {
    const key = "ready:" + (s.newVersion || "");
    bannerEl.dataset.key = key; if (dismissed === key) return;
    bannerEl.classList.add("ready");
    textEl.innerHTML = "<b>Update ready</b>" + (s.newVersion ? " (v" + s.newVersion + ")" : "") + " \u2014 restart to install.";
    btnEl.style.display = "";
    show();
  } else if (s.status === "error") {
    if (s.quiet) { hide(); return; }   // background (launch/periodic) check — don't nag during a service
    bannerEl.dataset.key = "err"; if (dismissed === "err") return;
    bannerEl.classList.add("err");
    textEl.innerHTML = "<b>Update check failed.</b> Will retry shortly.";
    show();
    setTimeout(hide, 6000);
  } else {
    // idle | checking | current  -> nothing to show
    hide();
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", injectBanner);
} else { injectBanner(); }

ipcRenderer.on("updater:status", (_e, s) => { injectBanner(); render(s); });
