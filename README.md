# Lower Thirds Engine

A desktop app that turns **ProPresenter 7** into broadcast graphics for **OBS**
and **ATEM** — scripture + reference, names/titles, sermon bullets, auto/manual
event lists, and media overlays — with a Preview/Program switcher and an OBS
output that auto-syncs so its URL never changes.

It's a single-file graphics engine (`lt.html`) wrapped in Electron, with a small
in-app relay and GitHub-Releases auto-update.

---

## For operators (using the app)

1. Install **Lower Thirds Engine Setup.exe** from the
   [Releases](../../releases) page. (First launch shows a Windows
   "unrecognized app" notice → **More info → Run anyway**; that's expected for an
   unsigned build.)
2. Open the app. The operator console loads.
3. In ProPresenter: **Settings → Network → enable**, note the IP + port; enter
   them at the bottom of the console and Connect.
4. In OBS: add a **Browser Source**, URL **`http://localhost:7777/output`**,
   1920×1080, and turn **off** "Shutdown source when not visible."
   (Menu **File → Copy OBS Output URL** copies it for you.)
5. Build your look in **Preview**, hit **Take** to send it live to **Program**
   (and OBS). The Take button reads **ON AIR** (green) when Program matches
   Preview, **TAKE TO AIR** (red) when you have changes to push.

**F1 (Clear All)** in ProPresenter clears everything including the Scripture
reference list; other clears (F2 / clear-slide) leave the list up.

When a new version is published, the app shows **"Update available → downloading
→ Restart & Install."**

---

## For developers

```bash
npm install      # electron + electron-builder + electron-updater
npm test         # syntax-check lt.html + 9 jsdom suites  (keep green)
npm start        # run the app locally
npm run dist     # build a Windows installer locally -> release\
```

Releasing is tag-driven: `npm version patch && git push --tags` → GitHub Actions
builds and publishes the Windows installer, and running apps pick it up.

- **`CLAUDE.md`** — architecture + file map (start here).
- **`CLAUDE_CODE_TASKS.md`** — finalize + release walkthrough.
- **`DEV.md`** — test harness conventions.

---

## How it fits together

```
                ┌───────────────────────── Electron app ─────────────────────────┐
ProPresenter ──▶│  relay.js (in-proc, :7777)  ──serves──▶  lt.html (Console)      │
  (HTTP API)    │        ▲  proxy /pp                         │ Take              │
                │        │                                    ▼                   │
                │        └───────── SSE /events ◀──── POST /config (Program)      │
                └───────────────────────────────│───────────────────────────────┘
                                                 ▼
                                    OBS Browser Source
                              http://localhost:7777/output
                                 (transparent 1920×1080)  ──▶  ATEM / stream
```

The OBS URL is constant; "Take" pushes the look through the relay to the output.
