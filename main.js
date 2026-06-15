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

// electron-updater / electron-log are optional at dev-time; guard so `npm start`
// works even before a publish target is configured.
let autoUpdater = null, log = null;
try { autoUpdater = require("electron-updater").autoUpdater; } catch (e) {}
try { log = require("electron-log"); } catch (e) {}

const PORT = 7777;
let win = null;
let relayServer = null;
let updateState = { status: "idle" };   // idle|checking|current|available|downloading|ready|error

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
    // check for updates shortly after launch (packaged builds only)
    if (app.isPackaged && autoUpdater) {
      setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (e) {} }, 3500);
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
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  win.on("closed", () => { win = null; });
}

function pushUpdateState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("updater:status", Object.assign({ version: app.getVersion() }, updateState));
  }
}

function setupUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;            // download in the background once found
  // Do NOT auto-apply on quit: a live booth shouldn't have its version swapped
  // between Saturday-night close and Sunday service. Install only on the explicit
  // "Restart & Install" click (ipcMain "updater:install" -> quitAndInstall).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => { updateState = { status: "checking" }; pushUpdateState(); });
  autoUpdater.on("update-available", (info) => { updateState = { status: "available", newVersion: info && info.version }; pushUpdateState(); });
  autoUpdater.on("update-not-available", () => { updateState = { status: "current" }; pushUpdateState(); });
  autoUpdater.on("download-progress", (p) => { updateState = { status: "downloading", percent: Math.round(p.percent || 0) }; pushUpdateState(); });
  autoUpdater.on("update-downloaded", (info) => { updateState = { status: "ready", newVersion: info && info.version }; pushUpdateState(); });
  autoUpdater.on("error", (err) => { updateState = { status: "error", message: String(err && err.message || err) }; pushUpdateState(); });
}

/* ----- IPC from the renderer (preload) ----- */
ipcMain.on("updater:check", () => {
  if (!autoUpdater) { updateState = { status: "error", message: "Updater not available in dev mode." }; pushUpdateState(); return; }
  try { autoUpdater.checkForUpdates(); } catch (e) { updateState = { status: "error", message: String(e && e.message || e) }; pushUpdateState(); }
});
ipcMain.on("updater:install", () => { if (autoUpdater) { try { autoUpdater.quitAndInstall(); } catch (e) {} } });
ipcMain.handle("app:info", () => ({ version: app.getVersion(), name: app.getName(), port: PORT, packaged: app.isPackaged }));

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
          click: () => shell.openExternal("http://localhost:" + PORT + "/output"),
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
app.on("before-quit", () => { try { if (relayServer) relayServer.close(); } catch (e) {} relayServer = null; });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
