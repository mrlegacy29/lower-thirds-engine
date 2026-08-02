/* ============================================================================
   Lower Thirds Engine — Electron main process
   ----------------------------------------------------------------------------
   - Hosts the relay (relay.js) IN-PROCESS, so the OBS Browser Source URL
     (http://localhost:7777/output) is live whenever the app is running.
   - Loads the operator console in the app window.
   - Checks GitHub Releases for updates via electron-updater and tells the
     renderer (preload injects the "Update available" banner).
   ========================================================================== */

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require("electron");
const path = require("path");
const relay = require("./relay");
// DeckLink fill+key output. Self-contained and fail-soft: if the optional native
// bridge isn't present it reports an actionable status instead of throwing, so a
// stream PC without a card (or without the SDK) is completely unaffected.
let sdi = null;
try { sdi = require("./sdi"); } catch (e) { sdi = null; }

// electron-updater / electron-log are optional at dev-time; guard so `npm start`
// works even before a publish target is configured.
let autoUpdater = null, log = null;
try { autoUpdater = require("electron-updater").autoUpdater; } catch (e) {}
try { log = require("electron-log"); } catch (e) {}

const PORT = 7777;
let win = null;
let relayServer = null;
let updateState = { status: "idle" };   // idle|checking|current|available|downloading|ready|error
let manualCheck = false;                 // true only for an explicit "Check for Updates" — gates whether a failed check shows a banner
let updateTimer = null;                  // periodic background update check (every 5 min while running)

/* ----- single instance: don't double-bind the relay port ----- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(boot);
}

function boot() {
  if (log) { try { log.transports.file.level = "info"; if (autoUpdater) autoUpdater.logger = log; } catch (e) {} }

  // 1) start the relay in-process (quiet — no console banner inside the app)
  try {
    relayServer = relay.start({ port: PORT, htmlFile: path.join(__dirname, "lt.html"), quiet: true });
  } catch (e) {
    dialog.showErrorBox("Startup error", String(e && e.message || e));
    app.quit(); return;
  }

  let booted = false;
  // Only open the window once the relay is actually listening, so the console
  // (and the OBS /output URL) never load against a port that failed to bind.
  relayServer.on("listening", () => {
    if (booted) return; booted = true;
    createWindow();
    buildMenu();
    setupUpdater();
    // live SDI status -> console (frame counter, key level, faults)
    if (sdi) sdi.onStatus((s) => { if (win && !win.isDestroyed()) win.webContents.send("sdi:status", s); });
    // check for updates shortly after launch, then every 5 minutes while running
    // (packaged builds only). Both are background checks, so a failed check stays quiet.
    if (app.isPackaged && autoUpdater) {
      setTimeout(() => { manualCheck = false; safeCheckForUpdates(); }, 3500);
      updateTimer = setInterval(() => { manualCheck = false; safeCheckForUpdates(); }, 5 * 60 * 1000);
    }
  });

  relayServer.on("error", (err) => {
    // A runtime error after a good start shouldn't kill the app mid-service.
    if (booted) { if (log) { try { log.error("relay runtime error:", err); } catch (e) {} } return; }
    const inUse = err && err.code === "EADDRINUSE";
    dialog.showErrorBox(
      inUse ? ("Port " + PORT + " is in use") : "Local server error",
      (inUse
        ? ("Lower Thirds Engine couldn't start its local server on port " + PORT + ".\n\n" +
           "Something else is using that port (another copy of this app, or a leftover\n" +
           "'node relay.js' window). Close it and reopen the app.\n\n")
        : "The local server failed to start, so the app can't run reliably.\n\n") +
      String(err && err.message || err));
    try { if (relayServer) relayServer.close(); } catch (e) {}
    relayServer = null;
    app.quit();   // fail closed rather than leave a dead/foreign window open
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 900, minWidth: 1100, minHeight: 720,
    backgroundColor: "#0b0f17",
    title: "Lower Thirds Engine",
    icon: path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL("http://localhost:" + PORT + "/");
  win.webContents.on("did-finish-load", () => pushUpdateState());
  // open target=_blank / external links in the user's real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { Promise.resolve(shell.openExternal(url)).catch(() => {}); return { action: "deny" }; }
    return { action: "allow" };
  });
  win.on("closed", () => { win = null; });
}

function pushUpdateState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("updater:status", Object.assign({ version: app.getVersion() }, updateState));
  }
}

// checkForUpdates() REJECTS asynchronously (no network, DNS blocked, 404 on
// latest.yml). A synchronous try/catch cannot see that, so a failed background check
// surfaced as an unhandled rejection in the main process. Route every call here.
function safeCheckForUpdates() {
  if (!autoUpdater) { updateState = { status: "error", message: "Updater not available in dev mode." }; pushUpdateState(); return; }
  try {
    const p = autoUpdater.checkForUpdates();
    if (p && typeof p.catch === "function") {
      p.catch((e) => { updateState = { status: "error", message: String((e && e.message) || e), quiet: !manualCheck }; pushUpdateState(); });
    }
  } catch (e) {
    updateState = { status: "error", message: String((e && e.message) || e), quiet: !manualCheck }; pushUpdateState();
  }
}

function setupUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;            // download in the background once found
  // Do NOT auto-apply on quit: a live stream PC shouldn't have its version swapped
  // between Saturday-night close and Sunday service. Install only on the explicit
  // "Restart & Install" click (ipcMain "updater:install" -> quitAndInstall).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => { updateState = { status: "checking" }; pushUpdateState(); });
  autoUpdater.on("update-available", (info) => { updateState = { status: "available", newVersion: info && info.version }; pushUpdateState(); });
  autoUpdater.on("update-not-available", () => {
    // Tell the operator when THEY asked; stay silent for the background checks so
    // nothing flashes mid-service.
    updateState = { status: "current", announce: manualCheck }; pushUpdateState();
  });
  autoUpdater.on("download-progress", (p) => { updateState = { status: "downloading", percent: Math.round(p.percent || 0) }; pushUpdateState(); });
  autoUpdater.on("update-downloaded", (info) => { updateState = { status: "ready", newVersion: info && info.version }; pushUpdateState(); });
  autoUpdater.on("error", (err) => { updateState = { status: "error", message: String(err && err.message || err), quiet: !manualCheck }; pushUpdateState(); });
}

/* ----- IPC from the renderer (preload) ----- */
ipcMain.on("updater:check", () => {
  manualCheck = true;   // explicit user check (menu / banner) — surface the result, including failures
  if (!autoUpdater) { updateState = { status: "error", message: "Updater not available in dev mode." }; pushUpdateState(); return; }
  safeCheckForUpdates();
});
ipcMain.on("updater:install", () => { if (autoUpdater) { try { autoUpdater.quitAndInstall(); } catch (e) {} } });
ipcMain.handle("app:info", () => ({ version: app.getVersion(), name: app.getName(), port: PORT, packaged: app.isPackaged }));

/* ----- DeckLink SDI fill + key -----
   Every handler answers with a plain object rather than rejecting, so a renderer
   mid-service never has to deal with an exception on a hardware call. */
function sdiUnavailable() {
  return { supported: false, on: false, reason: "SDI output module failed to load.", frames: 0, dropped: 0 };
}
ipcMain.handle("sdi:status",  () => (sdi ? sdi.status() : sdiUnavailable()));
ipcMain.handle("sdi:modes",   () => (sdi ? sdi.modes() : []));
ipcMain.handle("sdi:devices", async () => (sdi ? await sdi.listDevices() : []));
ipcMain.handle("sdi:start",   async (_e, opts) => {
  if (!sdi) return sdiUnavailable();
  try {
    const o = Object.assign({}, opts, { url: "http://localhost:" + PORT + "/output" });
    return await sdi.start(o);
  } catch (e) { return sdi.status(); }   // status already carries the human-readable error
});
ipcMain.handle("sdi:stop",  async () => { if (!sdi) return sdiUnavailable(); try { return await sdi.stop(); } catch (e) { return sdi.status(); } });
ipcMain.handle("sdi:level", (_e, v) => { if (!sdi) return sdiUnavailable(); try { sdi.setLevel(v); } catch (e) {} return sdi.status(); });
ipcMain.on("sdi:ramp", (_e, dir, frames) => {
  if (!sdi) return;
  try { dir === "down" ? sdi.rampDown(frames) : sdi.rampUp(frames); } catch (e) {}
});
ipcMain.handle("sdi:test", async (_e, seconds) => {
  if (!sdi) return sdiUnavailable();
  try { return await sdi.testPattern(seconds); } catch (e) { return sdi.status(); }
});

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Copy OBS Output URL",
          click: () => {
            const { clipboard } = require("electron");
            clipboard.writeText("http://localhost:" + PORT + "/output");
            if (win) dialog.showMessageBox(win, { type: "info", title: "OBS URL copied",
              message: "OBS Browser Source URL copied:\n\nhttp://localhost:" + PORT + "/output",
              detail: "1920 x 1080. In OBS, turn OFF 'Shutdown source when not visible'." });
          },
        },
        {
          label: "Open Output in Browser",
          click: () => { Promise.resolve(shell.openExternal("http://localhost:" + PORT + "/output")).catch(() => {}); },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
        { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates\u2026",
          click: () => { ipcMain.emit("updater:check"); },
        },
        {
          label: "About Lower Thirds Engine",
          click: () => {
            if (!win) return;
            dialog.showMessageBox(win, {
              type: "info", title: "About",
              message: "Lower Thirds Engine",
              detail: "Version " + app.getVersion() + "\n" +
                      "ProPresenter 7 broadcast graphics for OBS / ATEM.\n\n" +
                      "OBS Browser Source: http://localhost:" + PORT + "/output",
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Tear the relay down only on real quit (Windows: window close => quit => here).
// On macOS the app stays alive in the dock with the relay still serving OBS, so
// re-activating reopens a window pointed at a live server (not a dead port).
// Release the DeckLink before the relay: the card is an exclusive resource, and
// leaving it open would block the next launch (or ProPresenter) from claiming it.
app.on("before-quit", () => {
  try { if (sdi) sdi.stop(); } catch (e) {}
  try { if (relayServer) relayServer.close(); } catch (e) {} relayServer = null;
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// The SDI renderer is an OFFSCREEN BrowserWindow, so it counts as an open window and
// 'window-all-closed' never fires while SDI is running: closing the console left an
// invisible process still holding the DeckLink and port 7777, and the next launch
// failed to bind. Quit when the last VISIBLE window goes, releasing the card first.
function visibleWindowCount() {
  return BrowserWindow.getAllWindows().filter((w) => {
    try { return !w.isDestroyed() && !w.webContents.isOffscreen(); } catch (e) { return true; }
  }).length;
}
app.on("browser-window-closed", () => {
  if (process.platform === "darwin") return;
  // defer: the window is still in getAllWindows() during this event
  setImmediate(() => {
    if (visibleWindowCount() === 0) { try { if (sdi) sdi.stop(); } catch (e) {} app.quit(); }
  });
});
app.on("activate", () => { if (visibleWindowCount() === 0) createWindow(); });
