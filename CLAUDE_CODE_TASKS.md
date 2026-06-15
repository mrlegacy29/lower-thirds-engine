# Build & Release Tasks (do these in Claude Code)

This turns the project into a downloadable Windows app with auto-update. Work
top to bottom. Anything marked **REPLACE** is a placeholder you must fill in.

---

## 0. Prerequisites (one time)

- **Node.js 22.12 or newer** installed (`node -v`) — required by
  electron-builder 26. (Node 22 LTS is the safe choice.)
- A **GitHub account** and an **empty public repo** (suggested name:
  `lower-thirds-engine`). Public is required so the app can pull updates without
  embedding a token.
- **Git** configured locally.

> Dependency versions in `package.json` are **pinned to exact, current-stable
> releases** (electron 42.4.0, electron-builder 26.15.2, electron-updater 6.8.3,
> electron-log 5.4.4, jsdom 29.1.1 — all verified June 2026). The first
> `npm install` creates a `package-lock.json`; **commit it** so every build is
> reproducible.

---

## 1. Fill in the placeholders

**`package.json`**
- `author` → your name / email (**REPLACE_ME**).
- `build.publish[0].owner` → your GitHub username (**REPLACE_GH_USERNAME**).
- `build.publish[0].repo` → your repo name (default `lower-thirds-engine`).
- (Optional) `build.appId` is `com.lowerthirds.engine` — fine to leave.

That's the only required editing. The GitHub owner/repo is what links the app's
update check to your releases.

---

## 2. Install & sanity-check

```bash
npm install
npm test          # must print "ALL SUITES PASSED"
npm start         # the desktop app opens; the operator console loads
```

In `npm start`, confirm:
- The window shows the operator console.
- **File → Copy OBS Output URL** gives `http://localhost:7777/output`.
- Point OBS (or just a browser) at that URL → transparent output renders.
- ProPresenter IP/Port at the bottom connects to your real machine.

> The relay runs **inside** the app now — no separate `node relay.js` window.
> (The old `start-relay.bat` / standalone path still works if you ever want the
> no-install version, but the desktop app is self-contained.)

---

## 3. Put it on GitHub

```bash
git init
git add .
git commit -m "Lower Thirds Engine desktop app v1.0.0"
git branch -M main
git remote add origin https://github.com/REPLACE_GH_USERNAME/lower-thirds-engine.git
git push -u origin main
```

> Make sure the `package-lock.json` created by `npm install` in step 2 is part
> of this commit (`git status` should show it). It pins transitive dependencies
> so CI and your machine build identically.

---

## 4. Cut the first release (this builds the installer)

You have two ways. **The tag way is the one you'll use going forward.**

### A) The tag way (recommended — fully automated)
The repo already includes `.github/workflows/release.yml`. Just push a tag that
matches the version in `package.json`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will: install → `npm test` → build the Windows installer →
publish a **GitHub Release** with `Lower Thirds Engine-Setup-1.0.0.exe` and the
`latest.yml` file the updater reads. Watch it under the repo's **Actions** tab.
When it's done, download the `.exe` from the repo's **Releases** page and install
on the church PC.

### B) The local way (build on your own Windows machine)
If you'd rather build locally (or aren't using Actions):

```bash
# create a GitHub Personal Access Token with "repo" scope, then:
setx GH_TOKEN "ghp_your_token_here"   # Windows; reopen the terminal after
npm run release                        # builds AND publishes the release
# ...or build without publishing:
npm run dist                           # installer lands in  release\
```

> **You must build the Windows installer on Windows** (or via the Actions
> workflow, which runs on Windows). You can't produce a working `.exe` from
> macOS/Linux. The Actions route avoids needing a Windows machine at all.

---

## 5. The update loop (every time you change the app)

This is the workflow you asked for — edit in Claude Code, and running copies get
a "new update available" notification:

1. Make your changes (usually in `lt.html`).
2. `npm test` → must be green.
3. Bump the version and tag in one step:
   ```bash
   npm version patch        # 1.0.0 -> 1.0.1 (use "minor"/"major" as needed)
   git push && git push --tags
   ```
   (`npm version` edits `package.json`, commits, and creates the `v1.0.1` tag.)
4. GitHub Actions builds + publishes the new release automatically.
5. Any open copy of the app checks GitHub on next launch, shows
   **"Update available → downloading…"**, then **"Update ready — Restart &
   Install."** The user clicks restart and they're on the new version.

That's it. No re-sending files by hand.

---

## 6. Good-to-know / finalize checklist

- [ ] **Icon** — `build/icon.ico` is a generic placeholder. Drop in your own
      256×256 (multi-size) `.ico` if you want custom art. Re-run a release.
- [ ] **App name** — shown as "Lower Thirds Engine" (window title, installer,
      Start Menu). Change `productName` in `package.json` to rename.
- [ ] **SmartScreen warning (expected):** because the build isn't code-signed,
      Windows will show "Windows protected your PC → More info → Run anyway" the
      first time. This is normal for unsigned apps and does **not** affect
      auto-update. To remove it later, buy a Windows code-signing certificate and
      add `win.certificateFile` / password (or an EV cert) to the build config.
- [ ] **Port 7777** — if another app uses it, change `PORT` in **both**
      `main.js` and `relay.js`, and re-point OBS to the new `/output` URL.
- [ ] **Test on the booth PC** — install the `.exe`, run a full ProPresenter →
      OBS pass before relying on it for a service.
- [ ] **Private source?** If you ever want the code private but keep updates
      working: make a **second public repo** for releases only and point
      `build.publish` at it. Ask me and I'll wire it.

---

## Quick reference

| I want to… | Run |
|------------|-----|
| Run the app locally | `npm start` |
| Verify nothing broke | `npm test` |
| Build an installer (no publish) | `npm run dist` → `release\` |
| Build + publish a release | tag push (`npm version patch && git push --tags`) |
| See what shipped | repo → **Releases** |
