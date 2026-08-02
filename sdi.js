/* ============================================================================
   Lower Thirds Engine — DeckLink SDI fill + key output
   ----------------------------------------------------------------------------
   Renders the /output page offscreen and pushes it straight out a Blackmagic
   DeckLink as a fill + key pair, so the ATEM keys the graphic itself. No OBS in
   the graphics path, so Program AND every Aux get the lower third with no
   compositing latency.

   THE PIPELINE
     lt.html /output  (transparent 1920x1080 layer)
        |  rendered by
     offscreen BrowserWindow  -> 'paint' -> nativeImage.getBitmap()  = BGRA
        |  newest-frame-wins buffer (the two clocks are independent)
     macadam.playback({ pixelFormat: bmdFormat8BitBGRA,
                        enableKeying: true, isExternal: true })
        |
     DeckLink SDI fill + key  ->  ATEM upstream/downstream keyer

   WHY BGRA: Electron's offscreen bitmap is BGRA and DeckLink's keying formats
   are 8-bit ARGB/BGRA, alpha 0 = transparent, 255 = opaque. They line up with no
   conversion. Chromium composites PRE-MULTIPLIED, which is why the ATEM keyer
   must have "Pre Multiplied Key" ON — same setting ProPresenter's alpha keyer
   needs.

   WHY newest-frame-wins: the browser paints when content changes; the card pulls
   at a fixed SDI rate. Queueing frames would drift and eventually judder. The
   pump always sends the most recent frame and simply repeats it when the page is
   idle, which is exactly right for lower thirds (mostly static, occasionally
   animating).

   'macadam' is an OPTIONAL dependency — it needs the Blackmagic Desktop Video
   SDK present at build time. Everything here degrades to a clear, actionable
   status when it is missing; nothing throws and the rest of the app is
   unaffected.
   ========================================================================== */

// Guarded so the pure parts (mode table, availability, health shape) can be required
// and unit-tested under plain node, where 'electron' isn't resolvable. start() is the
// only thing that needs a real BrowserWindow, and it checks before using it.
let BrowserWindow = null;
try { ({ BrowserWindow } = require("electron")); } catch (e) { BrowserWindow = null; }

// Try the upstream package and its known forks, so whichever one is made to build
// on this machine gets picked up without a code change. All of them expose the same
// playback()/keying API.
const BRIDGES = ["macadam", "@rezonant/macadam", "@byslin/macadam"];
let macadam = null, bridgeName = null, loadError = null;
for (const name of BRIDGES) {
  try { macadam = require(name); bridgeName = name; loadError = null; break; }
  catch (e) { if (!loadError) loadError = String((e && e.message) || e); }
}

/* ---------------------------------------------------------------- video modes
   fps is the RENDER rate for the offscreen page. For interlaced modes that is
   the FRAME rate (i50 = 25 frames/s); the card handles fielding. Graphics are
   static or slow-moving, so progressive-rendered fields carry no comb artifacts.
   The mode MUST match the ATEM exactly or you get flicker or black. */
const MODES = [
  { id: "bmdModeHD1080p2398", label: "1080p 23.98", w: 1920, h: 1080, fps: 24 },
  { id: "bmdModeHD1080p24",   label: "1080p 24",    w: 1920, h: 1080, fps: 24 },
  { id: "bmdModeHD1080p25",   label: "1080p 25",    w: 1920, h: 1080, fps: 25 },
  { id: "bmdModeHD1080p2997", label: "1080p 29.97", w: 1920, h: 1080, fps: 30 },
  { id: "bmdModeHD1080p30",   label: "1080p 30",    w: 1920, h: 1080, fps: 30 },
  { id: "bmdModeHD1080p50",   label: "1080p 50",    w: 1920, h: 1080, fps: 50 },
  { id: "bmdModeHD1080p5994", label: "1080p 59.94", w: 1920, h: 1080, fps: 60 },
  { id: "bmdModeHD1080p6000", label: "1080p 60",    w: 1920, h: 1080, fps: 60 },
  { id: "bmdModeHD1080i50",   label: "1080i 50",    w: 1920, h: 1080, fps: 25 },
  { id: "bmdModeHD1080i5994", label: "1080i 59.94", w: 1920, h: 1080, fps: 30 },
  { id: "bmdModeHD1080i6000", label: "1080i 60",    w: 1920, h: 1080, fps: 30 },
  { id: "bmdModeHD720p50",    label: "720p 50",     w: 1280, h: 720,  fps: 50 },
  { id: "bmdModeHD720p5994",  label: "720p 59.94",  w: 1280, h: 720,  fps: 60 },
  { id: "bmdModeHD720p60",    label: "720p 60",     w: 1280, h: 720,  fps: 60 },
];
const DEFAULT_MODE = "bmdModeHD1080p5994";
function modeById(id) { return MODES.find((m) => m.id === id) || MODES.find((m) => m.id === DEFAULT_MODE); }

/* ------------------------------------------------------------------- state */
let win = null;          // offscreen renderer
let playback = null;     // macadam playback handle
let running = false;
let pumping = false;
let latest = null;       // newest BGRA frame
let state = { on: false, device: null, mode: null, level: 255, frames: 0, dropped: 0, error: null, reference: null };
let onChange = null;
let lastPaintAt = 0;     // renderer heartbeat — proves the page is still producing pixels
let lastFrameAt = 0;     // card heartbeat — proves the DeckLink is still taking frames
let recentDrops = 0;     // drops since the last health sample, so an old fault doesn't stick red
let deviceCaps = null;   // what the selected card says it can do (external keying, etc.)
const notify = () => { try { onChange && onChange(status()); } catch (e) {} };

function available() {
  if (macadam) return { ok: true, bridge: bridgeName };
  return {
    ok: false,
    reason:
      "The DeckLink bridge isn't installed, so SDI fill + key is unavailable.\n\n" +
      "It is a native module (macadam) that must compile on this machine. As of the last\n" +
      "check every published build dates from 2022 and does NOT compile against Node 24,\n" +
      "which is what this app runs — it fails on the N-API finalize signature, not on\n" +
      "anything to do with Blackmagic. See SDI-SETUP.md for the current state and the\n" +
      "workaround.\n\n" +
      "USE OBS INSTEAD — it drives the same card today, no compiling:\n" +
      "  1. Browser source -> the output URL, 1920x1080\n" +
      "  2. Settings > Advanced > Color Format = RGB   (without this there is no alpha)\n" +
      "  3. Tools > DeckLink Output -> your device, matching mode, Keyer = External\n" +
      (loadError ? "\nLoad error: " + loadError : ""),
  };
}

async function listDevices() {
  if (!macadam) return [];
  try {
    // macadam exposes a device count plus per-device info; tolerate either shape.
    const n = typeof macadam.deviceCount === "function" ? macadam.deviceCount() : (macadam.deviceCount || 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      let info = {};
      try { info = (typeof macadam.deviceInfo === "function" ? macadam.deviceInfo(i) : {}) || {}; } catch (e) {}
      out.push({
        index: i,
        name: info.modelName || info.displayName || ("DeckLink device " + i),
        display: info.displayName || info.modelName || ("DeckLink device " + i),
        // surface whether the card can actually do an external (fill+key) keyer
        keyable: info.supportsExternalKeying !== false,
      });
    }
    return out;
  } catch (e) { return []; }
}

/* ------------------------------------------------------------- frame source */
function startRenderer(url, mode) {
  win = new BrowserWindow({
    width: mode.w, height: mode.h,
    show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    webPreferences: {
      offscreen: true,           // -> 'paint' events with a CPU-readable bitmap
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // never slow down because the window is hidden
    },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setFrameRate(Math.min(60, mode.fps));   // Electron caps at 60
  win.webContents.on("paint", (_e, _dirty, image) => {
    try {
      const size = image.getSize();
      // Guard against a resize race: a wrong-sized buffer would be garbage on air.
      if (size.width !== mode.w || size.height !== mode.h) return;
      latest = image.getBitmap();     // BGRA, top-down, pre-multiplied
      lastPaintAt = Date.now();
    } catch (e) { /* drop this frame, keep the last good one */ }
  });
  win.webContents.on("render-process-gone", (_e, d) => {
    state.error = "Output renderer crashed (" + ((d && d.reason) || "unknown") + ")";
    notify();
  });
  return win.loadURL(url);
}

/* --------------------------------------------------------------- frame pump
   displayFrame() resolves when the card has taken the frame, so awaiting it in a
   loop paces us to the SDI clock automatically — no timers, no drift. */
let pumpGen = 0;
async function pump() {
  if (pumping) return;
  pumping = true;
  const myGen = pumpGen;
  const blank = Buffer.alloc(state._bytes, 0);   // fully transparent until the page paints
  while (running && playback && myGen === pumpGen) {
    try {
      const frame = latest || blank;
      await playback.displayFrame(frame);
      state.frames++;
      lastFrameAt = Date.now();
      if (state.frames % 30 === 0) {
        try { state.reference = playback.referenceStatus ? playback.referenceStatus() : null; } catch (e) {}
        notify();                                  // ~0.5s heartbeat so the lamp is responsive
      }
    } catch (e) {
      state.dropped++; recentDrops++;
      if (!running) break;
      state.error = String((e && e.message) || e);
      notify();
      await new Promise((r) => setTimeout(r, 250));   // don't spin on a hard fault
    }
  }
  pumping = false;
}

/* -------------------------------------------------------------- start / stop */
let starting = false;
async function start(opts) {
  opts = opts || {};
  if (!macadam) { const a = available(); state.error = a.reason; notify(); throw new Error(a.reason); }
  if (!BrowserWindow) { state.error = "SDI output needs the desktop app (no renderer available)."; notify(); throw new Error(state.error); }
  // Re-entrancy guard. start() awaits, so a second click (or an IPC retry) could run
  // the whole body concurrently: `if (running) await stop()` never saw running=true
  // because the first call had not set it yet, and the second opened another offscreen
  // window and another device handle, orphaning the first.
  if (starting) throw new Error("SDI output is already starting.");
  starting = true;
  try {
  if (running) await stop();

  const mode = modeById(opts.mode);
  const deviceIndex = Number(opts.deviceIndex) || 0;
  const level = Math.max(0, Math.min(255, opts.level == null ? 255 : Number(opts.level)));
  const url = opts.url || "http://localhost:7777/output";

  state = { on: false, device: deviceIndex, mode: mode.id, level, frames: 0, dropped: 0, error: null, reference: null };
  state._bytes = mode.w * mode.h * 4;
  latest = null; lastPaintAt = 0; lastFrameAt = 0; recentDrops = 0;
  try { deviceCaps = (await listDevices()).find((d) => d.index === deviceIndex) || null; } catch (e) { deviceCaps = null; }

  try {
    await startRenderer(url, mode);
  } catch (e) {
    await teardown();
    state.error = "Couldn't load the output page: " + String((e && e.message) || e);
    notify(); throw e;
  }

  try {
    playback = await macadam.playback({
      deviceIndex,
      displayMode: macadam[mode.id],
      pixelFormat: macadam.bmdFormat8BitBGRA,   // matches Electron's offscreen bitmap exactly
      enableKeying: true,
      isExternal: true,                          // external = fill on one SDI, key on the other
      level,
    });
  } catch (e) {
    await teardown();
    state.error =
      "The DeckLink wouldn't open for fill+key: " + String((e && e.message) || e) +
      "\n\nUsual causes: another app already owns the output (ProPresenter's alpha keyer " +
      "holds it), the card isn't mapped for keying in Desktop Video Setup, or the video " +
      "mode isn't supported for keying on this device.";
    notify(); throw e;
  }

  running = true; state.on = true;
  state.error = null;         // a clean start clears any error left by a previous run
  lastFrameAt = Date.now();   // so health() doesn't read "no frame in Infinity s" before the first one lands
  try { state.reference = playback.referenceStatus ? playback.referenceStatus() : null; } catch (e) {}
  notify();
  pump();                     // fire-and-forget; the loop owns its own errors
  return status();
  } finally { starting = false; }
}

async function teardown() {
  running = false;
  pumpGen++;                     // any in-flight pump belongs to an older generation now
  try { if (playback && playback.stop) playback.stop(); } catch (e) {}
  playback = null;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  win = null;
  latest = null;
  // Let an in-flight displayFrame settle before the caller reopens the device, but do
  // not trust it to finish: a wedged driver call could hang forever. After the wait we
  // clear `pumping` ourselves — leaving it set made the NEXT start() skip launching a
  // pump (pump() returns early when pumping is true), so the card opened and sent
  // nothing at all while the lamp read green.
  for (let i = 0; i < 40 && pumping; i++) await new Promise((r) => setTimeout(r, 25));
  pumping = false;
}

async function stop() {
  await teardown();
  state.on = false;
  notify();
  return status();
}

/* ------------------------------------------------------------------- extras */
function setLevel(v) {
  const level = Math.max(0, Math.min(255, Number(v) || 0));
  state.level = level;
  try { if (playback && playback.setLevel) playback.setLevel(level); } catch (e) {}
  notify();
  return level;
}
// Hardware key fades — smoother than animating opacity in the page, because the
// card ramps the key level itself on the SDI clock.
function rampUp(frames) { try { playback && playback.rampUp && playback.rampUp(Number(frames) || 12); } catch (e) {} }
function rampDown(frames) { try { playback && playback.rampDown && playback.rampDown(Number(frames) || 12); } catch (e) {} }

/* --------------------------------------------------------------------- health
   Drives the console's status lamp. Each check is independent so the operator is
   told WHICH thing is wrong, not just "not connected".

   IMPORTANT AND DELIBERATE: green means "this card is sending a valid fill+key
   pair". SDI is one-way — nothing downstream reports back — so the app CANNOT
   know the cables reach the ATEM or that the keyer is set up right. The UI says
   so explicitly rather than implying an end-to-end confirmation it can't make. */
function health() {
  const now = Date.now();
  const checks = [];
  const add = (id, label, st, detail) => checks.push({ id, label, state: st, detail: detail || "" });

  if (!macadam) {
    add("bridge", "DeckLink bridge installed", "fail", "macadam is not installed — see the setup note below.");
    return { level: "red", checks, summary: "DeckLink bridge not installed" };
  }
  add("bridge", "DeckLink bridge installed", "ok", "");

  if (!state.on) {
    add("output", "Fill + key output open", "fail", state.error ? String(state.error).split("\n")[0] : "Not started.");
    return { level: "red", checks, summary: state.error ? "Output error" : "Idle — not sending SDI" };
  }

  add("device", "Card open", "ok", "Device " + state.device + " · " + (state.mode ? modeById(state.mode).label : "?"));
  add("keyer", "External keyer (fill + key) enabled", deviceCaps && deviceCaps.keyable === false ? "warn" : "ok",
      deviceCaps && deviceCaps.keyable === false ? "Card did not report external-keying support — output may be fill-only." : "");

  const paintAge = lastPaintAt ? now - lastPaintAt : Infinity;
  // The page legitimately stops painting when nothing changes, so a quiet renderer
  // is only a problem if it never painted at all.
  if (!lastPaintAt) add("render", "Graphics page rendering", "warn", "No frame painted yet — the output page may not have loaded.");
  else add("render", "Graphics page rendering", "ok", "last paint " + Math.round(paintAge / 100) / 10 + "s ago");

  const frameAge = lastFrameAt ? now - lastFrameAt : Infinity;
  if (frameAge > 2000) add("frames", "Card accepting frames", "fail", "No frame accepted in " + Math.round(frameAge / 1000) + "s — output has stalled.");
  else add("frames", "Card accepting frames", "ok", state.frames + " sent");

  if (recentDrops > 0) add("drops", "No dropped frames", "warn", recentDrops + " dropped since last check");
  else add("drops", "No dropped frames", "ok", "");
  recentDrops = 0;

  // Genlock is a quality signal, not a hard failure: an un-genlocked card still
  // outputs, it just risks drift against the ATEM's clock over a long service.
  const ref = state.reference;
  if (ref == null) add("genlock", "Reference / genlock", "warn", "Not reported by the driver.");
  else if (/lock/i.test(String(ref)) && !/unlock|not/i.test(String(ref))) add("genlock", "Reference / genlock", "ok", String(ref));
  else add("genlock", "Reference / genlock", "warn", String(ref) + " — fine for graphics, but genlock is steadier.");

  const fail = checks.some((c) => c.state === "fail");
  const warn = checks.some((c) => c.state === "warn");
  return {
    level: fail ? "red" : warn ? "amber" : "green",
    checks,
    summary: fail ? (checks.find((c) => c.state === "fail") || {}).detail
           : warn ? "Sending — with warnings"
           : "Sending fill + key",
  };
}

/* --------------------------------------------------------------- test pattern
   For cabling/keyer setup: puts an unmistakable card on air for a few seconds so
   the operator can confirm on the ATEM multiview which SDI is fill and which is
   key, and that the transparent region really keys through. */
const TEST_CARD =
  "<html><body style='margin:0;background:transparent;font-family:Arial,Helvetica,sans-serif'>" +
  "<div style='position:absolute;left:0;top:0;width:100%;height:33%;background:#ff0000'></div>" +
  "<div style='position:absolute;left:0;top:33%;width:100%;height:34%;background:#00ff00'></div>" +
  "<div style='position:absolute;left:0;top:67%;width:100%;height:33%;background:#0000ff'></div>" +
  "<div style='position:absolute;left:12%;top:26%;width:76%;height:48%;background:rgba(0,0,0,0)'></div>" +
  "<div style='position:absolute;left:0;top:44%;width:100%;text-align:center;color:#fff;" +
  "font-size:64px;font-weight:800;text-shadow:0 2px 12px #000'>FILL + KEY TEST</div>" +
  "<div style='position:absolute;left:0;top:56%;width:100%;text-align:center;color:#fff;font-size:26px;" +
  "text-shadow:0 2px 8px #000'>bars = FILL &nbsp;·&nbsp; white silhouette = KEY &nbsp;·&nbsp; centre box must key through</div>" +
  "</body></html>";

async function testPattern(seconds) {
  if (!running || !win || win.isDestroyed()) throw new Error("Start the SDI output first.");
  const back = win.webContents.getURL();
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TEST_CARD));
  await new Promise((r) => setTimeout(r, Math.max(1, Math.min(60, Number(seconds) || 10)) * 1000));
  if (running && win && !win.isDestroyed()) await win.loadURL(back);
  return status();
}

function status() {
  const a = available();
  return {
    supported: a.ok,
    reason: a.ok ? null : a.reason,
    on: !!state.on,
    device: state.device,
    mode: state.mode,
    modeLabel: state.mode ? modeById(state.mode).label : null,
    level: state.level,
    frames: state.frames,
    dropped: state.dropped,
    error: state.error,
    reference: state.reference,
    health: health(),
  };
}

function onStatus(cb) { onChange = cb; }
function modes() { return MODES.map((m) => ({ id: m.id, label: m.label, w: m.w, h: m.h, fps: m.fps })); }

module.exports = { available, listDevices, modes, start, stop, setLevel, rampUp, rampDown,
                   status, health, testPattern, onStatus, MODES, DEFAULT_MODE };
