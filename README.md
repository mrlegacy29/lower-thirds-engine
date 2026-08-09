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

**F2 (Clear Slide)** takes **everything** off air except the running lists — the
Scripture reference list and the Event list keep their title and their entries.
That's the state you sit in between sermon points. **F1 (Clear All)** ends the
session: everything goes, lists, logo and all. Both are transient — the next
live slide brings every element back with nothing to re-arm. If one element
should ride through clears (a countdown, a watermark), tick **Stay on air
through ProPresenter clears** in its *Display & layering* panel. ProPresenter
can only tell the two clears apart when something besides the slide is on
screen (a background counts), so pick the detection rule under **Connection →
Clear behavior** and watch the live layer readout while you test.

### Routing by ProPresenter group (or slide label)

Name a position in ProPresenter — "Top Lower 3rds", "Bot Lower 3rds", whatever
you like — then bind an element to it with the dropdown beside its name in
**Layers** (or the same setting in the inspector). That element only goes on air
while a slide filed under that name is live, so one verse lands top, the next
lands bottom, and you never touch the app during a service.

**Use Groups.** ProPresenter publishes its whole **Settings → Groups** library
over its API, so a custom group you create there appears in the dropdown the
moment the app connects — before you have opened a single presentation. Slide
labels work identically, but ProPresenter does **not** publish its Slide Labels
library, so a label only appears here once the app has seen a deck carrying it.

The dropdown fills itself: the Groups library on connect, plus the groups and
labels of whatever deck ProPresenter has open — it does not have to be on screen,
so you can set up next Sunday's deck without presenting it. Anything it has ever
seen is remembered. If something is still missing, pick **Type a label…** at the
bottom of the list and type it; matching ignores case and stray spaces.

Bound elements stay visible in the **Preview** so you can still position them;
the **Program** monitor and OBS obey the binding.

In the dropdown, **L·** marks a slide label and **G·** marks a group — the two
can share a name and route differently, so the kind is always in the text. The
**● On the live slide** entries at the top bind to whatever ProPresenter has up
right now, without you having to remember how the slide was filed.

The same dropdown also answers the rest of "when does this layer show?":
**● Always live / on** keeps the layer up through Clear Slide, Clear All and
every slide change — perfect for the logo — and **○ Never show** hides it (same
as the eye). Picking a label or *Any slide* afterwards brings it back to normal
routing.

### Background image / video — three ways in

Every element's *Background image / video* panel takes media three ways, same
idea as OBS's media sources:

- **Import** embeds the file into the show file itself. Portable — an exported
  look carries it to another PC — but everything on a Take has to fit one 5 MB
  message, so this is for logos and stills, not loops.
- **Web URL** links to hosted media. Costs the look nothing.
- **Local file** links to a file on this PC — `C:\Videos\loop.mp4` or a
  `file:///…` URL (pasting either into the URL field works too). No size limit,
  so this is the way to run a big worship loop. The desktop app / relay serves
  the file to OBS, so it must be running and the file must stay at that path;
  a look exported to another computer needs the same file there.

### Matching layers to each other

Styling four positions to look identical used to mean setting the same ~30
controls four times. Open the source layer, hit **Copy this layer's look**
(bottom of the inspector), tick the layers that should receive it — per layer,
with an *All layers* shortcut — and paste. Background, media, animation, motion
and text styling transfer; content, position, size and ProPresenter bindings
never do, so each layer keeps its own job. Between different element types the
text styles map by role (main text → main text, secondary line → secondary
line). The paste is confirmed first, and nothing reaches air until you press
**Take**.

### Logo / slogan layer

Add a **Logo / Slogan** layer for a church logo, ministry name or strapline. It
rides above the lower thirds and carries text, a slogan line, and an image or
MP4 (drop a PNG in *Background image / video* and leave the text blank for a
plain logo bug).

Like everything else, **F1 / Clear All takes it down** — and the next live slide
brings it straight back, still armed. The **Logo / Slogan** row under the
monitors is the manual control: clicks go straight to air with no Take, and the
button reads **● ON AIR**, **◐ cleared by F1/F2** (armed, but a clear is holding
it off), or **○ off**. Clicking it on while the screen is cleared forces the
logo up anyway — for the post-service ident — and the next live slide hands
control back to ProPresenter. Tick **Stay on air through ProPresenter clears**
on the element if it should ignore F1/F2 entirely.

When a new version is published, the app shows **"Update available → downloading
→ Restart & Install."**

---

## For developers

```bash
npm install      # electron + electron-builder + electron-updater
npm test         # syntax-check lt.html + every jsdom suite  (keep green)
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
