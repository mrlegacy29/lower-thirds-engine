# Lower Thirds Engine — project guide (read me first)

This is a **desktop app** (Electron) wrapper around a single-file broadcast
graphics engine for ProPresenter 7 → OBS / ATEM. The engine itself is one HTML
file; Electron hosts it plus a tiny relay and adds auto-update.

## What each file is

| File | Role | Edit it? |
|------|------|----------|
| `lt.html` | **THE app.** All operator-console + OBS-output UI, rendering, ProPresenter polling, Take/Program logic, every element type and control. ~123 KB, single file (HTML + CSS + JS). | **Yes — this is where features live.** |
| `relay.js` | Tiny local HTTP server. Serves `lt.html` at `/` and `/output`, relays config console→OBS over SSE, proxies ProPresenter (kills CORS). Exports `start()` so Electron hosts it in-process; also runs standalone via `node relay.js`. | Rarely. It's stable. |
| `main.js` | Electron main process. Starts the relay in-process on port **7777**, opens the console window, wires `electron-updater` (GitHub Releases), builds the menu. | For app-shell behavior only. |
| `preload.js` | Injects the "Update available" banner into the page and bridges updater IPC. Keeps `lt.html` clean (banner only appears in the desktop app). | For update-UI tweaks. |
| `build/icon.ico` / `icon.png` | App icon. | Replace if you want different art. |
| `test/*.js` + `test/run-all.js` | 9 jsdom suites covering every control, clear-detection (F1/F2), media/motion, layering/dock, operator mode, take-state, glow/shape/bevel. | Add a suite when you add a feature. |
| `.github/workflows/release.yml` | On a `v*` tag push: install → test → build Windows installer → publish GitHub Release. | Rarely. |

## Architecture in one paragraph

`lt.html` runs in two modes, decided by the URL: **Console** (the operator UI,
served at `/`) and **Output** (a transparent 1920×1080 layer for OBS, served at
`/output`). The operator edits **Preview**, hits **Take**, which copies Preview→
**Program** and POSTs Program to `relay.js`; the Output page is subscribed to the
relay over SSE, so OBS updates without ever changing its URL. Both pages poll
ProPresenter (through the relay's `/pp` proxy) for the live slide + layer status.
Electron simply hosts the relay and the Console window in one app, and checks
GitHub for updates.

## Golden rules

1. **Features go in `lt.html`.** It must keep working as a plain file in a
   browser and in OBS — so never hard-depend on Electron there. Anything
   Electron-only (like the updater) is detected at runtime (`window.ltDesktop`).
2. **The OBS URL is sacred:** `http://localhost:7777/output`. Don't change the
   port without a reason; if you must, update `PORT` in both `main.js` and
   `relay.js` and tell the user to re-point OBS.
3. **Always run `npm test` before building or releasing.** `run-all.js`
   syntax-checks `lt.html` and runs all 9 suites. Green = safe to ship.
4. **One source of truth.** There's no build step for `lt.html`; it ships as-is.

## Common commands

```bash
npm install      # first time (pulls electron + electron-builder + updater)
npm test         # syntax-check lt.html + run all 9 suites  (MUST be green)
npm start        # run the desktop app locally (dev)
npm run dist     # build a Windows installer locally, no publish  -> release/
npm run release  # build + publish to GitHub Releases (needs GH_TOKEN)
```

See `CLAUDE_CODE_TASKS.md` for the finalize + first-release checklist and the
"ship an update" loop.
