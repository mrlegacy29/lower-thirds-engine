// A ProPresenter clear takes the SCREEN down, not just the verse.
//
// WHY THIS SUITE EXISTS. contentFor() returns {} — not null — for every MANUAL-source
// element, so activeBase() said "on air" and nothing the operator typed by hand could ever
// be cleared from ProPresenter. Measured on the real output page before the fix:
//
//   after F2 (Clear Slide)  ON AIR: sermon title, name/title, text box, bullet list,
//                                   event list, QR, clock, logo, AND the reference list
//   after F1 (Clear All)    ON AIR: all of the above except the reference list
//
// i.e. F1 — the key whose whole job is "clear everything" — left thirteen markers painted.
// Brandon asked for the two keys to mean what they are called:
//
//   F1 / Clear All    nothing survives. Ends the session.
//   F2 / Clear Slide  the running LISTS survive — the scripture reference list and the event
//                     list — entries AND their heading/title, because they are the record of
//                     where the sermon has been. Only F1 takes them away.
//
// The TITLE is asserted separately from the entries: the heading is drawn by the list
// element, so an implementation that exempted only the chips would leave the running list on
// air under no heading at all, which is the bare-plate failure this app has hit before.
//
// Three things make this worth its own suite rather than a few lines bolted onto
// clear_rule_test (which owns the LIST and HEADER rules, and the clearRule migration):
//
//   1. It has to cover EVERY element type, not a representative one. The gate lives in
//      activeBase(), which every type flows through, but the types differ in how they get
//      their content — and it was precisely the "returns {}" types that were broken.
//   2. It has to prove the clear is TRANSIENT. Writing visible=false would pass every
//      "is it off air" assertion here and leave the operator re-arming eight elements after
//      every clear for the rest of the service. The next-live-slide assertions are the ones
//      that separate the correct fix from the plausible one.
//   3. It has to prove a live slide carrying NO TEXT is not treated as a clear. Both arrive
//      at onSlide as text==="", and blanking the screen for an image-only or blank slide
//      would pull every lower third off air with ProPresenter still showing something. That
//      one is asserted last and it is the reason isClear() exists.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');
const { onAirText } = require('./_onair');

let slideText = '', slideActive = true, layersObj = null, presActive = true, layersFail = false;
const errors = [];
// Captured from the class the page constructs at boot. Installing the capturing stub AFTER
// the page has already subscribed is too late — it leaves every push() a no-op, which makes
// every "is it on air" assertion fail and every "is it off air" assertion pass vacuously.
let sseInst = null;

const sd = (o) => Object.assign({ font: "'Oswald',sans-serif", size: 40, weight: '600', color: '#ffffff', letter: 0, lh: 1.18, upper: false, italic: false, maxLines: 0 }, o || {});

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/output', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor(u) { this.url = u; sseInst = this; setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0);
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      const url = String(u);
      if (/active/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation: presActive ? { id: { uuid: 'x', name: 'Deck', index: 0 } } : null }) });
      if (/layers/.test(url)) {
        if (layersFail) return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(layersObj || { slide: false, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false }) });
      }
      if (/slide/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' '));
    w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

const VERSE       = { slide: true,  media: true,  props: false, messages: false, announcements: false, audio: false, video_input: false };
const CLEAR_SLIDE = { slide: false, media: true,  props: false, messages: false, announcements: false, audio: false, video_input: false };
const ALL_OFF     = { slide: false, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false };

// One marker per element type. Each is unique, so an assertion cannot pass because some
// OTHER element happens to carry the same words.
const MARKERS = {
  sermonTitle: 'SERMONMARK', name: 'NAMEMARK', text: 'TEXTMARK', bulletList: 'BULLETMARK',
  eventList: 'EVENTMARK', qr: 'QRMARK', clock: 'CLOCKMARK', logo: 'LOGOMARK',
};
const ALL_MARKS = Object.keys(MARKERS).map(k => MARKERS[k]);

const buildCfg = (over) => {
  const cfg = W.defaultConfig();
  const mk = (type, content, style, extra) => {
    const e = W.createElement(type);
    e.source = { kind: 'manual' };
    e.anim = Object.assign({}, e.anim, { durIn: 0, durOut: 0 });
    if (content) e.content = Object.assign({}, e.content, content);
    if (style) e.style = style;
    return Object.assign(e, extra || {});
  };
  cfg.elements = [
    // live-sourced, so it was already clearable — kept as the control
    (() => { const e = W.createElement('scripture'); e.source = { kind: 'live', requireRef: true };
             e.anim = Object.assign({}, e.anim, { durIn: 0, durOut: 0 }); return e; })(),
    (() => { const e = W.createElement('history');
             e.anim = Object.assign({}, e.anim, { durIn: 0, durOut: 0 }); return e; })(),
    mk('sermonTitle', { title: MARKERS.sermonTitle, sub: 'SUBMARK' }),
    mk('name',        { name: MARKERS.name, title: 'ROLEMARK' }),
    mk('text',        { text: MARKERS.text }),
    mk('bulletList',  { heading: MARKERS.bulletList, bullets: 'BULLETITEM', marker: '•' }),
    mk('eventList',   { heading: MARKERS.eventList, items: 'EVENTITEM' }),
    mk('qr',          { text: 'https://give.example.com', label: MARKERS.qr }),
    mk('clock',       { mode: 'countdown', label: MARKERS.clock, target: '23:59' }),
    mk('logo',        { title: MARKERS.logo, sub: 'SLOGANMARK' }, null, { visible: true }),
  ];
  cfg.conn = Object.assign({}, cfg.conn, { host: '127.0.0.1', port: 1025, pollMs: 100 });
  Object.assign(cfg, over || {});
  return cfg;
};
const push = (cfg) => { if (sseInst && sseInst.onmessage) sseInst.onmessage({ data: JSON.stringify({ type: 'program', cfg }) }); };
const air = () => onAirText(D, W, '#out-scaler');
// The reference-list CHIPS only. Needed to tell "this verse is in the list" apart from
// "this verse is the live one the scripture element is rendering" — they carry the same
// text, so a whole-stage read cannot distinguish them, and a manual clear that immediately
// re-logs the on-screen verse would pass unnoticed.
const { painted } = require('./_onair');
// Scoped to the SCRIPTURE reference list specifically: the event list renders the same
// .h-items/.h-chip markup, so an unscoped selector reports its items as scripture entries
// and "the list is empty" can never be true.
const listChips = () => {
  const wrap = [...D.querySelectorAll('#out-scaler .lt-el')].find(e => {
    const h = e.querySelector('.h-label');
    return h && /previously referenced/i.test(h.textContent || '');
  }) || [...D.querySelectorAll('#out-scaler .lt-el')].find(e => e.querySelector('.h-items') && !/EVENTITEM/.test(e.textContent));
  if (!wrap) return [];
  return [...wrap.querySelectorAll('.h-items .h-chip .tx')].filter(n => painted(n, W, D)).map(n => n.textContent.trim());
};
const onAir = (m) => air().includes(m);
const allOn = () => ALL_MARKS.filter(onAir);
const allOff = () => ALL_MARKS.filter(m => !onAir(m));

(async () => {
  await sleep(200);
  ok('output page booted', D.body.classList.contains('output'));

  let take = 100;
  push(buildCfg({ _take: ++take }));
  await sleep(150);
  slideText = 'John 3:16\nFor God so loved the world.'; slideActive = true; presActive = true; layersObj = VERSE;
  await sleep(400);
  slideText = 'Romans 8:28\nAnd we know.'; await sleep(400);

  /* ---------- baseline: with a verse live, everything is up ---------- */
  ok('live: every element type is on air', allOff().length === 0);
  // The verse BODY, not the reference: "Romans 8:28" is also a chip in the reference list,
  // so a reference-based check here would pass on the list alone and could not tell the
  // scripture element apart from it. That distinction is the entire point of the F2 rule.
  ok('live: the verse itself is on air', onAir('And we know'));
  ok('live: the reference list carries the earlier verse', onAir('John 3:16'));

  /* ---------- F2 / Clear Slide: ONLY the reference list survives ---------- */
  slideText = ''; slideActive = false; presActive = false; layersObj = CLEAR_SLIDE;
  await sleep(600);
  // Asserted type by type rather than as one aggregate, so a failure names the type that
  // regressed instead of just "something is still up".
  // The two running LISTS are exempt from F2 — everything else goes.
  Object.keys(MARKERS).filter(t => t !== 'eventList')
    .forEach(t => ok('F2 clears ' + t, !onAir(MARKERS[t])));
  // Again the BODY. "Romans 8:28" is legitimately still on air as a reference-list chip.
  ok('F2: the live verse is off air', !onAir('And we know'));
  ok('F2: the reference list SURVIVES, with its entries', onAir('John 3:16') && onAir('Romans 8:28'));
  // The list TITLE, explicitly. It is drawn by the list element, so an implementation that
  // exempted only the CHIPS would leave the running list up under no heading at all.
  ok('F2: ...and the list TITLE survives with it', /PREVIOUSLY REFERENCED/i.test(air()));
  ok('F2: the event list survives too, heading and items',
     onAir(MARKERS.eventList) && onAir('EVENTITEM'));

  /* ---------- the next live slide brings everything back, with nothing re-armed ---------- */
  slideText = 'Psalm 23:1\nThe Lord is my shepherd.'; slideActive = true; presActive = true; layersObj = VERSE;
  await sleep(500);
  ok('after F2, the next live slide restores every element', allOff().length === 0);

  /* ---------- F1 / Clear All: NOTHING survives ---------- */
  slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF;
  await sleep(600);
  Object.keys(MARKERS).forEach(t => ok('F1 clears ' + t, !onAir(MARKERS[t])));
  ok('F1: the reference list goes too', !onAir('Psalm 23:1') && !onAir('John 3:16'));
  ok('F1: its TITLE goes too', !/PREVIOUSLY REFERENCED/i.test(air()));
  ok('F1: the event list goes too, items and all',
     !onAir(MARKERS.eventList) && !onAir('EVENTITEM'));
  ok('F1: nothing whatsoever is left painted', air().trim() === '');

  /* ---------- TRANSIENT, not a write to .visible ----------
     This is the assertion that separates the correct fix from the plausible one. A fix that
     set visible=false passes every "is it off air" check above and leaves the operator
     re-enabling eight elements by hand after every clear. */
  slideText = 'Isaiah 40:31\nThey shall mount up.'; slideActive = true; presActive = true; layersObj = VERSE;
  await sleep(500);
  ok('after F1, the next live slide restores every element', allOff().length === 0);
  ok('...and the new verse is on air', onAir('Isaiah 40:31'));

  /* ---------- a live slide with NO TEXT is not a clear ----------
     Both reach onSlide as text==="". Treating a blank/image-only slide as a clear would pull
     every lower third off air while ProPresenter is still showing something. The slide LAYER
     is the discriminator — see isClear(). */
  slideText = ''; slideActive = true; presActive = true; layersObj = VERSE;
  await sleep(500);
  ok('a live slide with no text does NOT clear the screen', allOn().length === ALL_MARKS.length);

  /* ---------- the per-element escape hatch ---------- */
  {
    const cfg = buildCfg({ _take: ++take });
    cfg.elements.forEach(e => { if (e.type === 'clock' || e.type === 'name') e.clearImmune = true; });
    push(cfg); await sleep(200);
    slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF;
    await sleep(600);
    ok('clearImmune: an opted-out clock rides through F1', onAir(MARKERS.clock));
    ok('clearImmune: an opted-out name/title rides through F1', onAir(MARKERS.name));
    ok('clearImmune: everything else still clears', !onAir(MARKERS.sermonTitle) && !onAir(MARKERS.text) && !onAir(MARKERS.logo));
    ok('clearImmune: it is per-element, not a global off switch',
       !onAir(MARKERS.bulletList) && !onAir(MARKERS.qr) && !onAir(MARKERS.sermonTitle));
  }

  /* ---------- the Logo row's manual override: up over a cleared screen, then retired ----------
     F1 clearing the logo must not leave the operator with no way to put the church logo up
     on the post-service blank screen. The console's Logo/Slogan row sets _clearOver when
     clicked ON during a clear and broadcasts it; the next live slide retires it, so the
     override cannot quietly exempt the logo from next week's F1. */
  {
    const cfg = buildCfg({ _take: ++take });
    push(cfg); await sleep(200);
    slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF;
    await sleep(600);
    ok('override setup: F1 has the logo off air', !onAir(MARKERS.logo));
    const forced = buildCfg({ _take: ++take });
    forced.elements.forEach(e => { if (e.type === 'logo') { e.visible = true; e._clearOver = true; } });
    push(forced); await sleep(300);
    ok('the Logo row can force it up over a cleared screen', onAir(MARKERS.logo));
    slideText = 'John 14:6\nI am the way.'; slideActive = true; presActive = true; layersObj = VERSE;
    await sleep(500);
    slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF;
    await sleep(600);
    ok('...and a live slide retires the override, so the NEXT F1 clears it again', !onAir(MARKERS.logo));
  }

  /* ---------- the reference list's own "clear on F1" toggle still wins on F1 ----------
     Turning it OFF has always meant "this list survives a full clear", and the list-emptying
     paths honour that. Blanking the element anyway would have left a list that still held
     every reference and could not be seen. */
  {
    const cfg = buildCfg({ _take: ++take });
    cfg.elements.forEach(e => { if (e.type === 'history') e.clearOnAll = false; });
    push(cfg); await sleep(200);
    slideText = 'Acts 2:42\nThey devoted themselves.'; slideActive = true; presActive = true; layersObj = VERSE;
    await sleep(400);
    slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF;
    await sleep(600);
    ok('reference list with auto-clear OFF stays visible through F1', onAir('Acts 2:42'));
    ok('...while the rest of the screen still clears', allOff().length === ALL_MARKS.length);
  }


  /* ---------- F2 WITH NOTHING ELSE ON SCREEN — the rig this was lost on ----------
     THE regression. Every case above models Clear Slide as {slide:false, media:TRUE}, i.e. a
     background layer still running, which is the ONLY state where ProPresenter's API can
     tell the two clears apart. Running scripture with no background — how a sermon is
     actually run — makes F2 report EXACTLY what F1 reports: every layer off. The engine
     read that as Clear All and destroyed the reference list mid-sermon, repeatedly, while
     32 suites stayed green because not one of them modelled it.
     isListClear now demands POSITIVE evidence before emptying the list: an all-off reading
     is only attributable to Clear All if something besides the slide was on screen a moment
     earlier and went down with it. No evidence -> the list is left alone. Wiping it wrongly
     is irreversible; keeping it wrongly costs one click on the Clear scripture list button. */
  {
    const NOBG_LIVE = { slide: true,  media: false, props: false, messages: false, announcements: false, audio: false, video_input: false };
    push(buildCfg({ _take: ++take })); await sleep(200);
    slideText = 'John 3:16\nFor God so loved the world.'; slideActive = true; presActive = true; layersObj = NOBG_LIVE;
    await sleep(400);
    slideText = 'Romans 8:28\nAnd we know.'; await sleep(400);
    ok('no-background rig: the list builds up while live', onAir('John 3:16'));

    // F2 here is byte-identical to F1: everything off, nothing to attribute it to.
    slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF;
    await sleep(700);
    /* presActive=false here reproduces what a REAL ProPresenter does, measured 2026-08-16 by
       triggering each clear through the API and sampling every status endpoint: F1 and F2
       leave byte-identical state, presentation absent for both. The app therefore cannot
       attribute this clear — and an unattributable clear is a Clear SLIDE, so the list must
       SURVIVE. F1 is owned by the app's own key instead of being inferred (see doClearAll),
       which is what makes that safe. */
    ok('unattributable clear: the list survives (it is a Clear Slide by definition)', onAir('John 3:16'));
    ok('unattributable clear: its title survives too', /PREVIOUSLY REFERENCED/i.test(air()));
    ok('unattributable clear: the rest of the screen still goes',
       !onAir(MARKERS.sermonTitle) && !onAir(MARKERS.logo));


    // A rig WITH a background layer can still positively identify Clear All, and there the
    // list must still clear — otherwise this fix would just disable the feature.
    slideText = 'Acts 2:42\nThey devoted themselves.'; slideActive = true; presActive = true; layersObj = VERSE;
    await sleep(400);
    slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF;
    await sleep(700);
    ok('with a background layer, a real Clear All still empties the list', !onAir('John 3:16') && !onAir('Acts 2:42'));
    ok('...and drops the title', !/PREVIOUSLY REFERENCED/i.test(air()));
  }

  /* ---------- A DEAD LAYERS ENDPOINT MUST NOT LATCH THE SCREEN BLANK ----------
     Found by an adversarial audit and reproduced on the real output page. On a transient
     layers miss the poller reuses the LAST GOOD reading — right for one bad tick. But if the
     last good reading was "slide layer off" (i.e. any clear, which happens constantly) and
     the endpoint then stays down, every subsequent poll re-asserts that clear. Now that a
     clear takes the whole screen down, OBS goes blank and STAYS blank while ProPresenter is
     showing a live verse, and nothing recovers it short of reloading /output — the failure
     path never touched unknownLayers, so the text-mode fallback was never reached either.
     After N consecutive FAILURES the poller degrades to the text-mode reading instead
     (active===null: non-empty slide text means live), the same fallback used on a
     ProPresenter build with no layers API at all. */
  {
    push(buildCfg({ _take: ++take })); await sleep(200);
    layersFail = false;
    slideText = 'Mark 1:1\nThe beginning of the gospel.'; slideActive = true; presActive = true; layersObj = VERSE;
    await sleep(400);
    // a clear, so the last good layers reading is "slide off"
    slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF;
    await sleep(500);
    ok('latch: the screen is blank right after the clear (as designed)', !onAir(MARKERS.sermonTitle));
    // ProPresenter comes back with a live verse, but the layers endpoint is now down
    layersFail = true;
    slideText = 'Luke 4:18\nThe Spirit of the Lord is upon me.'; slideActive = true; presActive = true; layersObj = VERSE;
    await sleep(900);
    ok('latch: a live verse still reaches air with the layers endpoint down', onAir('The Spirit of the Lord'));
    ok('latch: ...and so does the rest of the screen', allOff().length === 0);
    slideText = 'Luke 4:19\nTo proclaim the year of the Lord.'; await sleep(500);
    ok('latch: advancing slides keeps working', onAir('To proclaim the year'));
    layersFail = false;
    await sleep(400);
    ok('latch: and it recovers cleanly when the endpoint returns', onAir('To proclaim the year'));
  }

  /* ================= BRANDON'S RIG: F1 / F2 / F5, no background layer =================
     The setup that three releases got wrong: scripture only, nothing else on screen. The
     LAYER readings for F1 and F2 are identical there (everything off), so the layer rules
     are blind — but ProPresenter's key map is not ambiguous at all:
        F1 Clear All   -> deck cleared      (presentation: null)
        F2 Clear Slide -> deck still ACTIVE (presentation: populated)
     The poller LEARNS that the presentation field separates them the first time it watches a
     live slide go off with the deck still active, and from then on that field decides. What
     the operator must see:
        F1  everything goes, list and title included
        F2  the scripture list and its title stay up, everything else goes
        F5  a dedicated key clears the list and title on demand  (see the _clearHist path) */
  {
    const NOBG_LIVE = { slide: true,  media: false, props: false, messages: false, announcements: false, audio: false, video_input: false };
    push(buildCfg({ _take: ++take })); await sleep(250);

    const liveVerse = async (ref, body) => {
      slideText = ref + '\n' + body; slideActive = true; presActive = true; layersObj = NOBG_LIVE; await sleep(350);
    };
    // F2: slide layer off, deck STILL ACTIVE
    const pressF2 = async () => { slideText = ''; slideActive = false; presActive = true; layersObj = ALL_OFF; await sleep(600); };
    // F1: slide layer off, deck CLEARED
    const pressF1 = async () => { slideText = ''; slideActive = false; presActive = false; layersObj = ALL_OFF; await sleep(600); };

    await liveVerse('John 3:16', 'For God so loved the world.');
    await liveVerse('Romans 8:28', 'And we know.');
    ok('rig: two verses are logged while live', onAir('John 3:16') && onAir('Romans 8:28'));

    await pressF2();
    ok('rig F2: the scripture list STAYS', onAir('John 3:16') && onAir('Romans 8:28'));
    ok('rig F2: its TITLE stays', /PREVIOUSLY REFERENCED/i.test(air()));
    ok('rig F2: the verse comes off air', !onAir('And we know'));
    ok('rig F2: and so does everything else', !onAir(MARKERS.sermonTitle) && !onAir(MARKERS.logo) && !onAir(MARKERS.qr));

    // ...and it holds across a whole sermon of F2s, which is the actual complaint.
    for (let i = 1; i <= 3; i++) { await liveVerse('Psalm 23:' + i, 'The Lord is my shepherd.'); await pressF2(); }
    ok('rig F2: the list survives a whole sermon of clears', onAir('John 3:16') && onAir('Psalm 23:3'));
    ok('rig F2: the title survives with it', /PREVIOUSLY REFERENCED/i.test(air()));

    // F1 must end the session: everything, list and title included.
    await liveVerse('Acts 2:42', 'They devoted themselves.');
    await pressF1();
    ok('rig F1: the scripture list is GONE', !onAir('John 3:16') && !onAir('Acts 2:42'));
    ok('rig F1: the title is GONE', !/PREVIOUSLY REFERENCED/i.test(air()));
    ok('rig F1: nothing whatsoever is left on air', air().trim() === '');

    // ...and the next slide brings the screen back, list re-accumulating from empty.
    await liveVerse('Luke 15:7', 'There is joy in heaven.');
    ok('rig: the next live slide restores the screen', allOff().length === 0);
    ok('rig: the list restarts empty after F1', !onAir('John 3:16') && onAir('Luke 15:7'));

    // F5 — the dedicated key. The desktop app turns the global shortcut into the SAME
    // _clearHist broadcast the "Clear scripture list" button sends, so exercising that
    // broadcast is exercising F5 end to end on the page OBS actually renders.
    await liveVerse('Micah 6:8', 'He has shown you what is good.');
    ok('rig F5 setup: the list has entries to clear', onAir('Luke 15:7') && onAir('Micah 6:8'));
    {
      const cfg = buildCfg({ _take: take, _clearHist: 9001 });
      push(cfg); await sleep(400);
      // Luke 15:7 exists ONLY as a list chip, so its absence is the list emptying. Micah 6:8
      // is deliberately NOT asserted gone: it is the verse ProPresenter still has on screen,
      // rendered by the scripture element, and F5 clears the list — not the live verse.
      ok('rig F5: the scripture list is cleared on demand', listChips().length === 0);
      // The verse ProPresenter still has UP must not walk straight back into the list on the
      // next poll — a clear that undoes itself in under a second is not a clear.
      await sleep(600);
      ok('rig F5: ...and STAYS cleared while that verse is still live', listChips().length === 0);
      ok('rig F5: the live verse itself is untouched', onAir('He has shown you what is good'));
      // Asserted BEFORE the next verse, or it measures the header legitimately coming back.
      ok('rig F5: the title goes with it', !/PREVIOUSLY REFERENCED/i.test(air()));
      ok('rig F5: and it does NOT disturb the rest of the screen',
         onAir(MARKERS.sermonTitle) && onAir(MARKERS.logo));
      // ...and the list starts working again on the NEXT reference, title included.
      await liveVerse('Titus 2:11', 'The grace of God has appeared.');
      ok('rig F5: the list resumes logging on the next verse', listChips().indexOf('Titus 2:11') >= 0);
      ok('rig F5: ...and the title comes back with it', /PREVIOUSLY REFERENCED/i.test(air()));
    }
  }

  /* ---------- the TITLE stays hidden until the first scripture ----------
     A fresh service: the app is open, ProPresenter is connected, songs may already have been
     up — but nothing has been REFERENCED yet, so "Previously Referenced" must not be on air.
     It only appears with the first verse, and it must behave the same on the builder Preview
     as it does on air (the builder used to force it visible, so the operator saw the title
     sitting there from launch and reasonably read that as broken). */
  {
    push(buildCfg({ _take: ++take, _clearHist: 9100 })); await sleep(300);
    slideText = ''; slideActive = false; presActive = true; layersObj = ALL_OFF; await sleep(400);
    ok('title: hidden before anything has been referenced', !/PREVIOUSLY REFERENCED/i.test(air()));
    // a SONG goes live — still no scripture, so still no title
    slideText = 'Great is thy faithfulness\nMorning by morning new mercies I see';
    slideActive = true; layersObj = VERSE; await sleep(450);
    ok('title: a song lyric does not raise it', !/PREVIOUSLY REFERENCED/i.test(air()));
    ok('title: ...and no chips appear for it', listChips().length === 0);
    // first real scripture
    slideText = 'Hebrews 4:12\nThe word of God is living and active.'; await sleep(450);
    ok('title: appears with the first scripture', /PREVIOUSLY REFERENCED/i.test(air()));
    ok('title: ...alongside its first entry', listChips().indexOf('Hebrews 4:12') >= 0);
  }

  console.log('CLEAR-SCREEN RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 6)) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('**FAIL** THREW: ' + e.message);
  console.log('CLEAR-SCREEN RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW');
  process.exit(1);
});
