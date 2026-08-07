// Coverage for the OBS Output page (the on-air half OBS renders): the isOutput
// bootstrap, SSE program subscribe (+ partial-config guard), live verse render,
// and the output page's OWN F1-vs-F2 history clear.
const { JSDOM } = require('jsdom');
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'lt.html'), 'utf8');
const errors = [];
let slideText = '', slideActive = true, layersObj = null, sseInst = null, presActive = true;
// Deck structure + which slide is live, for the ProPresenter label/group binding. Shape
// copied from a real PP 21.2 response: groups carry `name`, slides carry `label`, and
// /v1/presentation/slide_index is a FLAT index across every group.
let deckGroups = null, slideIdx = 0;
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/output', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor(u) { this.url = u; sseInst = this; setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.prompt = () => 'P'; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      const url = String(u);
      if (/active/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation: presActive ? { id: { uuid: 'x', name: 'Deck', index: 0 }, groups: deckGroups || undefined } : null }) });
      if (/layers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve(layersObj || { slide: slideActive, media: true }) });
      // BEFORE the /slide/ arm: "slide_index" contains "slide", so the generic arm would
      // answer it with a slide-text payload and the index would never resolve.
      if (/slide_index/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation_index: { index: slideIdx } }) });
      if (/slide/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
// PAINTED-only. These used to read textContent, which counts elements the engine has taken
// off air (it hides by setting opacity:0 on the .lt-el wrapper) — so "renders on air" passed
// for graphics composited fully transparent into the OBS browser source. See test/_onair.js.
const { painted, onAirText } = require('./_onair');
const outWrap = (sel) => [...D.querySelectorAll('#out-scaler .lt-el')].find(x => x.querySelector(sel));
const outRef = () => { const w = outWrap('.r-ref'); const n = w && w.querySelector('.r-ref');
  return (n && painted(n, W, D)) ? n.textContent : ''; };
const outList = () => { const e = outWrap('.h-items');
  return e ? [...e.querySelectorAll('.h-items .h-chip .tx')].filter(t => painted(t, W, D)).map(t => t.textContent) : []; };
const outHeadingShown = () => { const w = outWrap('.h-label'); const h = w && w.querySelector('.h-label');
  return !!h && h.style.display !== 'none' && painted(h, W, D); };
const pushSSE = (cfg) => { if (sseInst && sseInst.onmessage) sseInst.onmessage({ data: JSON.stringify({ type: 'program', cfg }) }); };

(async () => {
  await sleep(80);
  ok('output page booted (body.output)', D.body.classList.contains('output'));
  ok('output stage present (#out-scaler)', !!D.getElementById('out-scaler'));
  ok('defaultConfig accessible', typeof W.defaultConfig === 'function');

  // push a program over SSE with a connection so the PP poller starts on-output
  const prog = W.defaultConfig();
  prog.conn = Object.assign({}, prog.conn, { host: '127.0.0.1', port: 1025, pollMs: 200 });
  prog._take = 10;
  const errBefore = errors.length;
  pushSSE(prog); await sleep(80);
  ok('SSE program applies without console error', errors.length === errBefore);

  // live verse flows PP -> output render + output's own history log
  slideText = 'John 3:16\nFor God so loved the world.'; slideActive = true; layersObj = { slide: true, media: true }; await sleep(400);
  ok('live verse renders on the OUTPUT layer', /John 3:16/.test(outRef()));
  ok('verse logged to output history', outList().includes('John 3:16'));

  slideText = 'Romans 8:28\nAnd we know.'; await sleep(400);
  ok('second verse logged on output', outList().includes('Romans 8:28'));

  // F2 (Clear Slide) as ProPresenter 21.2 actually reports it (measured 2026-08-03):
  // slide off but MEDIA STILL ON, and presentation cleared. Not a full clear, so the verse
  // leaves air and the list stays up WITH ITS CONTENTS. The old fixture modelled this as
  // "presentation still active", which the real API never does for either clear.
  slideText = ''; slideActive = false; presActive = false; layersObj = { slide: false, media: true }; await sleep(700);
  ok('F2: output ref list KEEPS its entries', outList().includes('John 3:16') && outList().includes('Romans 8:28'));
  ok('F2: output header STAYS (media still on -> not a full clear)', outHeadingShown());
  // The verse itself must still leave air — "keep the list" must not mean "keep everything".
  ok('F2: the verse is off air', !/Romans 8:28/.test(outRef()));

  // re-populate, then F1 (Clear All): presentation cleared -> list clears AND header hides
  slideText = 'Psalm 23:1\nThe Lord is my shepherd.'; slideActive = true; presActive = true; layersObj = { slide: true, media: false }; await sleep(400);
  ok('output list repopulates', outList().includes('Psalm 23:1'));
  slideText = ''; slideActive = false; presActive = false; layersObj = { slide: false, media: false }; await sleep(700);
  ok('F1: output ref list clears', outList().length === 0);
  ok('F1: output header HIDES (presentation cleared)', !outHeadingShown());

  /* ---------- a NON-scripture slide must not raise an empty header ----------
     Reported from a live rig: booting into a worship set put a bare "Prev Scriptures"
     plate on air with nothing under it, and it stayed there through every song.
     onSlide() used to call setHeaderHold(true) unconditionally for ANY live text, so a
     song lyric, a sermon point or an announcement opened the list header even though no
     scripture had ever been referenced. The header belongs to the LIST — only a real
     reference opens it, and only a Clear Slide holds it open. */
  {
    // fresh session: nothing referenced yet, a song lyric goes live
    slideText = 'Children of generations\nOf every nation of Kingdom come';
    slideActive = true; presActive = true; layersObj = { slide: true, media: true };
    await sleep(450);
    ok('song lyric on air does NOT raise the empty ref-list header', !outHeadingShown());
    ok('...and the list stays empty', outList().length === 0);

    // a real verse opens it
    slideText = 'Psalm 23:1\nThe Lord is my shepherd.'; await sleep(450);
    ok('a real reference opens the header', outHeadingShown());
    ok('...and lists the reference', outList().includes('Psalm 23:1'));

    // back to a song — the list has content, so it legitimately stays up
    slideText = 'Children of generations\nOf every nation of Kingdom come'; await sleep(450);
    ok('after a verse, a song slide keeps the populated list up', outHeadingShown());

    // Clear All ends the session; a later song must not bring the bare header back
    slideText = ''; slideActive = false; presActive = false;
    layersObj = { slide: false, media: false }; await sleep(700);
    ok('Clear All hides the header again', !outHeadingShown());
    slideText = 'Of every nation of Kingdom come';
    slideActive = true; presActive = true; layersObj = { slide: true, media: true };
    await sleep(450);
    ok('a song after Clear All does NOT resurrect the empty header', !outHeadingShown());
  }

  /* ---------- ProPresenter LABEL binding, end to end on the on-air page ----------
     Brandon labels each slide in ProPresenter ("Top Lower 3rds", "Bot Lower 3rds") and the
     element bound to that label is the one that goes on air, so one verse lands top and the
     next lands bottom without touching the app. This drives the REAL path: the fake PP
     serves a grouped deck plus a flat slide_index, exactly as PP 21.2 does. */
  {
    deckGroups = [{ name: 'John 1:1-3', slides: [
      { label: 'Top Lower 3rds' }, { label: 'Bot Lower 3rds' }, { label: '' } ] }];
    slideIdx = 0;

    const cfg = W.defaultConfig();
    const mk = (id, txt, bind) => {
      const e = W.createElement('text');
      e.id = id; e.name = txt; e.content = { text: txt }; e.ppMatch = bind;
      e.source = { kind: 'manual' };          // always has something to say; only the gate can hide it
      e.anim = Object.assign({}, e.anim, { durIn: 0, durOut: 0 });
      return e;
    };
    cfg.elements = [ mk('t1', 'TOPSLOT', 'L:Top Lower 3rds'),
                     mk('t2', 'BOTSLOT', 'L:Bot Lower 3rds'),
                     mk('t3', 'UNBOUND', ''),
                     mk('t4', 'GROUPSLOT', 'G:John 1:1-3') ];
    cfg.conn = Object.assign({}, cfg.conn, { host: '127.0.0.1', port: 1025, pollMs: 200 });
    cfg._take = 30;
    pushSSE(cfg);
    slideText = 'John 1:1\nIn the beginning was the Word.';
    slideActive = true; presActive = true; layersObj = { slide: true, media: true };
    await sleep(600);

    const air = () => onAirText(D, W, '#out-scaler');
    ok('bound element matching the live slide label IS on air', /TOPSLOT/.test(air()));
    ok('bound element for a DIFFERENT label is not', !/BOTSLOT/.test(air()));
    ok('an unbound element is unaffected by the feature', /UNBOUND/.test(air()));
    ok('a GROUP binding matches the group the slide sits in', /GROUPSLOT/.test(air()));

    // same deck, next slide: the verse moves to the other position with no operator action
    slideIdx = 1; slideText = 'John 1:2\nThe same was in the beginning with God.';
    await sleep(600);
    ok('advancing to the next label moves the graphic', /BOTSLOT/.test(air()) && !/TOPSLOT/.test(air()));
    ok('...and the group binding still holds across slides of that group', /GROUPSLOT/.test(air()));

    // an UNLABELLED slide in the same deck: no label binding may match
    slideIdx = 2; slideText = 'John 1:3\nAll things were made by him.';
    await sleep(600);
    ok('an unlabelled slide lights no label-bound element',
       !/TOPSLOT/.test(air()) && !/BOTSLOT/.test(air()));
    ok('...while the unbound element stays put', /UNBOUND/.test(air()));

    // Clear All: nothing bound may stay pinned on air
    slideText = ''; slideActive = false; presActive = false; layersObj = { slide: false, media: false };
    await sleep(700);
    ok('Clear All takes every bound element off air',
       !/TOPSLOT|BOTSLOT|GROUPSLOT/.test(air()));

    deckGroups = null; slideIdx = 0; presActive = true;
    pushSSE(Object.assign(W.defaultConfig(), { conn: cfg.conn, _take: 31 })); await sleep(200);
  }

  /* ---------- Logo / Slogan layer, on the page OBS actually renders ----------
     The console suite (logo_layer_test) proves the operator row and the Program monitor.
     This is the OTHER render path, and the split between them is the single most repeated
     bug in this project. Two things have to hold here specifically:
       - no ProPresenter clear may take a logo down; and
       - the operator's toggle arrives as a plain bus.publish with NO _take bump, so the
         output page must re-render from a config change alone. If it only acted on a _take
         change, a logo would be impossible to clear from OBS for the rest of the service. */
  {
    const cfg = W.defaultConfig();
    const logo = W.createElement('logo');
    logo.id = 'lg1'; logo.name = 'Church logo';
    logo.content = { title: 'VICTORY WORSHIP', sub: 'Come as you are' };
    logo.visible = true;
    logo.anim = Object.assign({}, logo.anim, { durIn: 0, durOut: 0 });
    cfg.elements = cfg.elements.concat([logo]);
    cfg.conn = Object.assign({}, cfg.conn, { host: '127.0.0.1', port: 1025, pollMs: 200 });
    cfg._take = 40;
    pushSSE(cfg);
    slideText = 'John 3:16\nFor God so loved the world.'; slideActive = true; presActive = true;
    layersObj = { slide: true, media: true };
    await sleep(500);

    const air = () => onAirText(D, W, '#out-scaler');
    ok('logo: on air alongside a live verse', /VICTORY WORSHIP/.test(air()) && /John 3:16/.test(air()));

    // F2 — Clear Slide
    slideText = ''; slideActive = false; presActive = false; layersObj = { slide: false, media: true };
    await sleep(700);
    ok('logo: survives F2 on the output page', /VICTORY WORSHIP/.test(air()));

    // F1 — Clear All. Every visual layer off; the verse must go, the logo must not.
    layersObj = { slide: false, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false };
    await sleep(700);
    ok('logo: survives F1 (Clear All) on the output page', /VICTORY WORSHIP/.test(air()));
    ok('logo: ...and the verse really did clear', !/John 3:16/.test(air()));

    // The operator clears it: same _take, only .visible changed.
    const off = W.defaultConfig();
    off.elements = cfg.elements.map(e => e.id === 'lg1' ? Object.assign({}, e, { visible: false }) : e);
    off.conn = cfg.conn; off._take = 40;                 // DELIBERATELY unchanged
    pushSSE(off); await sleep(300);
    ok('logo: a visible-only broadcast (no new _take) takes it off air', !/VICTORY WORSHIP/.test(air()));

    const back = W.defaultConfig();
    back.elements = cfg.elements; back.conn = cfg.conn; back._take = 40;
    pushSSE(back); await sleep(300);
    ok('logo: ...and puts it straight back', /VICTORY WORSHIP/.test(air()));

    pushSSE(Object.assign(W.defaultConfig(), { conn: cfg.conn, _take: 41 })); await sleep(250);
    slideText = ''; slideActive = false; presActive = true; layersObj = { slide: false, media: true };
  }

  // a partial/garbage broadcast must not throw on-air (deepMerge guard)
  const errBefore2 = errors.length;
  pushSSE({ _take: 11 }); await sleep(80);
  ok('partial SSE config does not throw on-air', errors.length === errBefore2);

  /* ---------- the stock look must be usable out of the box (measured in OBS) ----------
     Caught on a real 1920x1080 OBS browser source, 2026-08-03. jsdom does no text layout
     (clientHeight/scrollHeight are always 0), so these are arithmetic guards on the
     declared geometry rather than rendered measurements. */
  {
    const cfg = W.defaultConfig();
    const scr = cfg.elements.find(e => e.type === 'scripture');
    const his = cfg.elements.find(e => e.type === 'history');

    // The body ships maxLines:3. The box must be tall enough for the reference line,
    // that many body lines, and boxDefaults padY top+bottom — otherwise the element
    // silently truncates its own verse. The old default (h:180) fit ONE line.
    const bs = scr.style.body, rs = scr.style.ref;
    const need = (bs.maxLines * bs.size * bs.lh) + (rs.size * rs.lh) + (scr.box.padY * 2);
    ok('scripture box fits the ' + bs.maxLines + ' lines it promises (need ' +
       Math.ceil(need) + 'px, has ' + scr.layout.h + ')', scr.layout.h >= need);

    // ...and stays inside the 1080 stage.
    ok('scripture sits on-stage', scr.layout.y + scr.layout.h <= 1080);

    // The two stock elements must not sit on top of each other.
    const ov = Math.min(scr.layout.y + scr.layout.h, his.layout.y + his.layout.h) -
               Math.max(scr.layout.y, his.layout.y);
    ok('stock scripture + reference list do not overlap (overlap ' + Math.max(0, ov) + 'px)', ov <= 0);
  }

  /* ------- the geometry fix has to REACH an install that already exists -------
     Changing createElement's defaults only affects elements created afterwards, so
     without migrateLayout the v1.3.3 fix helped nobody who was already running the app.
     The fixture below is Brandon's real stored config, read out of the running app. */
  {
    const ML = W.migrateLayout;
    ok('migrateLayout: reachable', typeof ML === 'function');

    const stored = { elements: [
      { type: 'scripture', layout: { x: 120, y: 820, w: 1100, h: 180 } },
      { type: 'history',   layout: { x: 120, y: 560, w: 620,  h: 380 } }
    ] };
    ML(stored);
    const s = stored.elements[0].layout, h = stored.elements[1].layout;
    ok('migrateLayout: an untouched stock scripture is rescued (h 180 -> 280)',
       s.y === 720 && s.h === 280);
    ok('migrateLayout: an untouched stock ref list moves clear of it',
       h.y === 340 && h.h === 360);
    ok('migrateLayout: the two no longer overlap',
       Math.min(s.y + s.h, h.y + h.h) - Math.max(s.y, h.y) <= 0);
    ok('migrateLayout: stamps _layoutMig', stored._layoutMig === true);

    // THE IMPORTANT ONE: an operator's own numbers must never be touched. One value
    // differing from the retired default is enough to mean "they moved it".
    const custom = { elements: [
      { type: 'scripture', layout: { x: 120, y: 820, w: 1100, h: 181 } },   // h nudged
      { type: 'history',   layout: { x: 200, y: 560, w: 620,  h: 380 } }    // x moved
    ] };
    ML(custom);
    ok('migrateLayout: a customised scripture is left ALONE',
       custom.elements[0].layout.h === 181 && custom.elements[0].layout.y === 820);
    ok('migrateLayout: a customised ref list is left ALONE',
       custom.elements[1].layout.x === 200 && custom.elements[1].layout.y === 560);

    // runs once — a config already migrated is never rewritten again
    const again = { _layoutMig: true, elements: [
      { type: 'scripture', layout: { x: 120, y: 820, w: 1100, h: 180 } } ] };
    ML(again);
    ok('migrateLayout: does not re-run on an already-migrated config',
       again.elements[0].layout.h === 180);

    let threw = false;
    try { ML(null); ML(undefined); ML({}); ML({ elements: null }); ML({ elements: [null, {}] }); }
    catch (e) { threw = true; }
    ok('migrateLayout: a malformed config does not throw', !threw);
  }

  /* -------- nothing unscannable, and no raw {{braces}}, may sit on air --------
     A QR that cannot produce a code used to stay on air painting only its caption
     ("SCAN TO GIVE") over an empty plate — which reads as working and sends the
     congregation nowhere. Three distinct ways to get there, only the first was handled.
     And the reference-list heading was the one operator-typed field that skipped subVars,
     so a bound placeholder went to air as literal braces. */
  {
    const onAirCount = () => [...D.querySelectorAll('#out-scaler .lt-el')]
      .filter(e => e.style.opacity !== '0').length;
    const mkQr = (text) => { const e = W.createElement('qr');
      e.content = Object.assign({}, e.content, { text, label: 'SCAN TO GIVE' }); return e; };
    const put = (els) => { const c = W.defaultConfig(); c.elements = els; c._take = Date.now();
      pushSSE(c); };

    put([mkQr('https://example.org/give')]); await sleep(350);
    ok('QR: a valid link goes on air', onAirCount() > 0);
    ok('QR: ...and actually carries a code', !!D.querySelector('#out-scaler svg'));

    put([mkQr('{{giveUrl}}')]); await sleep(350);
    ok('QR: an UNRESOLVED placeholder leaves air (no bare caption)', onAirCount() === 0);

    put([mkQr('https://')]); await sleep(350);
    ok('QR: the factory https:// sentinel leaves air', onAirCount() === 0);

    put([mkQr('https://example.org/' + 'x'.repeat(260))]); await sleep(350);
    ok('QR: a payload past the 213-byte capacity leaves air', onAirCount() === 0);

    // An eventList, NOT a history element: history has no items here, so its heading is
    // hidden and the assertion would pass whether or not substitution happened. eventList
    // supplies its own items, so the heading is genuinely painted.
    // Heading still renders (no regression from routing it through subVars). The
    // SUBSTITUTION itself is pinned in databind_test: CUR_VARS is overwritten by the stage
    // on every render from the live data feed (lt.html:2390), so a var injected from a test
    // cannot survive to paint time here — asserting it on this page would be theatre.
    // An UNKNOWN placeholder is also left verbatim by design, so braces alone prove nothing.
    const ev = W.createElement('eventList');
    ev.content = Object.assign({}, ev.content, { heading: 'Service Order', items: 'Welcome\nWorship' });
    put([ev]); await sleep(400);
    const air = onAirText(D, W);
    ok('list heading renders on air', /Service Order/.test(air));
    ok('...with its items', /Welcome/.test(air));
  }

  console.log('OUTPUT RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 6)) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('**FAIL** THREW: ' + e.message); console.log('OUTPUT RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW'); process.exit(1); });
