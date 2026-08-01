# DEV notes — test harness

All suites run under **jsdom** (no browser) and load `lt.html` from
`../lt.html`. `npm test` runs `test/run-all.js`, which first syntax-checks the
single-file app, then runs all 17 suites and aggregates pass/fail.

## Conventions that matter (jsdom quirks)

- **`element.animate` doesn't exist in jsdom.** All continuous-motion code in
  `lt.html` is guarded with `if(target.animate)`. To assert motion keyframes,
  stub it and record calls:
  ```js
  w.__anim=[];
  w.Element.prototype.animate=function(frames,opts){ w.__anim.push({el:this,frames,opts}); return {cancel(){},finished:Promise.resolve()}; };
  ```
- **`canvas.getContext` and `window.open` are missing** — guarded in the app;
  stub `URL.createObjectURL` when exercising media import.
- **Mock ProPresenter** by stubbing `w.fetch`: return `{current:{text}}` for
  `/slide` and a layers object for `/layers`. For **clear detection**, the
  layers object is what distinguishes F1 from F2:
  - `{slide:false, media:true}`  → Clear **Slide** (F2) — ref list stays.
  - `{slide:false, media:false}` → Clear **All** (F1) — ref list clears.
  Drive the feed by typing the IP into `input[placeholder="192.168.1.100"]` and
  clicking Connect; poll runs ~200 ms, so `await sleep(400)` between steps.
- **Hidden elements keep their text** — assert visibility via
  `style.opacity==='0'` or DOM presence, not by absence of text.
- **List exit animation** — the ref list animates out over ~450 ms; when
  asserting it cleared, wait ≥ 600–700 ms before reading the DOM.
- **Two `Color` labels exist** (text color + glow color); when targeting the
  glow picker, take the **last** matching label.

## The suites

| Suite | Covers |
|-------|--------|
| `final_check2` | every inspector control on every element type, reorder/delete, connect/live/clear, URL modes, presets, transition |
| `exclude_test2` | live-log behavior, exclude-live, **F1 vs F2 clear** (Clear-All empties the ref list, clear-slide keeps it), the clear-on-F1 toggle |
| `sweep` | broad add/select/edit pass |
| `evtest4` | manual event-list chips |
| `media_motion_test` | media URL/fit/crop/scrim + every motion type incl. ticker/roll |
| `motion_waapi_test` | exact keyframes per motion type (animate-stub) |
| `layer_dock_test` | persistent/always-on survives clear, linked visibility, z-order, yield-beneath, dock reflow |
| `operator_test` | view switching (Builder/Showcaller/Simple), look tiles, Blank, Take, ON-AIR, clock |
| `custom_take_test` | take pending/synced state + `_take` nonce, take-replay, glow color modes (single/dual/rainbow/size), bevel, shapes |
| `relay_test` | relay routes: `/`, `/output`, `/config` GET+POST, SSE `/events`, the `/pp` proxy |
| `output_test` | the OBS output page: isOutput bootstrap, SSE program subscribe, live verse render, output-side F1/F2 history clear |
| `pp_resilience_test` | ProPresenter poll failures hold the last good state instead of blanking the on-air verse |
| `clear_rule_test` | the configurable Clear Behavior rules (`pres` / `all` / layer-based) |
| `manual_source_test` | Scripture/Reference in **Manual** source render `d.content`; live elements never fall back to it (placeholder-leak guard) |
| `source_fallback_test` | the same source rules across **both** render paths (static *and* ticker), plus the Name/Text live-placeholder guard and the standing-role-label rule |
| `sdi_test` | DeckLink fill+key: `sdi.js` pure logic, the status lamp naming each fault, and the guard that SDI settings never enter the config |
| `relay_security_test` | the relay's origin policy: cross-origin and sandboxed-iframe writes to `/config` refused, `/pp` not an open proxy, no wildcard CORS, honest 400 on bad JSON |

## The source-fallback rule (read before touching `setText` / `marqText`)

Every element ships with placeholder content (`John 3:16`, `Pastor Mike Reynolds`,
`Custom text`) in `d.content`. What may fall back to it is **per type**, and two of the
rules are counterintuitive:

- **Scripture / Reference / Text** — fall back only when Source is *Manual*. `manualContent(d)`
  returns `null` for live elements precisely so they can't. Never loosen this: a non-scripture
  slide legitimately yields `{ref:"", body:<slide text>}`, so an unguarded fallback paints
  *John 3:16 next to an announcement slide*.
- **Name** — asymmetric on purpose, via `nameFor()` / `titleFor()`. The **name** never falls
  back when live. The **title** does, because it doubles as a standing role label for
  one-line slides — but only when a live name exists, so a blank slide paints nothing.

**Both render paths need every rule.** `setText()` early-returns into `renderMarquee()` when
Motion is Ticker or Credits-Roll, so `marqText()` renders that DOM instead and needs the
identical logic. A fix applied to only one path is invisible until someone turns on a ticker —
that is exactly how the manual-Scripture-scrolls-only-diamonds bug survived v1.0.5.

## Adding a feature

1. Implement in `lt.html`.
2. Add assertions to the closest existing suite, or a new `test/<name>.js`
   (and add its name to the `suites` array in `test/run-all.js`).
3. `npm test` must stay green before you bump the version and push a tag.
