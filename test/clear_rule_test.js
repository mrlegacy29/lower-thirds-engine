// Clear Behavior: the reference LIST clears on ANY clear; the HEADER stays through a
// Clear Slide and hides on a Clear All.
//
// CORRECTED 2026-08-03 against real hardware (ProPresenter 21.2). These fixtures used to
// model Clear Slide as "presentation still active", which is NOT what ProPresenter does —
// measured, it reports presentation:null for BOTH clears, so that model could never have
// worked and the test was validating a fiction:
//     state         slide   media   presentation
//     slide live    true    true    populated
//     Clear Slide   false   TRUE    null
//     Clear All     false   FALSE   null
// `media` is the real discriminator, which is what the default "all layers off" rule uses.
// Also covers the rule unit logic, the one-time clearRule migration, and the manual
// "Clear list" button.
const { JSDOM } = require('jsdom');
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'lt.html'), 'utf8');
const errors = [];
let slideText = '', slideActive = true, layersObj = null, presActive = true;
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.prompt = () => 'P'; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      const url = String(u);
      if (/active/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation: presActive ? { id: { uuid: 'x', name: 'Deck', index: 0 } } : null }) });   // /pp?target=...%2Fpresentation%2Factive (URL-encoded)
      if (/layers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve(layersObj || { slide: slideActive, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false }) });
      if (/slide/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = (n) => { if (!n) throw new Error('not found'); n.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
const pgEl = (sel) => [...D.querySelectorAll('#pg-scaler .lt-el')].find(x => x.querySelector(sel));
const pgList = () => { const e = pgEl('.h-items'); return e ? [...e.querySelectorAll('.h-items .h-chip .tx')].map(t => t.textContent) : []; };
const pgHeadingShown = () => { const w = [...D.querySelectorAll('#pg-scaler .lt-el')].find(x => x.querySelector('.h-label')); const h = w && w.querySelector('.h-label'); return !!h && h.style.display !== 'none'; };
const btnByText = (re) => [...D.querySelectorAll('button')].find(b => re.test(b.textContent));
const selType = (ty) => { const row = [...D.querySelectorAll('.elrow')].find(r => r.querySelector('.ty') && r.querySelector('.ty').textContent === ty); if (row) click(row.querySelector('.nm')); };
const VERSE = { slide: true, media: true, props: false, messages: false, announcements: false, audio: false, video_input: false };
const ALL_OFF = { slide: false, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false };
let pass = 0, fail = 0; const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

(async () => {
  await sleep(300);

  // ---- unit: the full-clear decision logic ----
  const f = W.isFullClear;
  if (typeof f === 'function') {
    ok('pres: full clear when presentation cleared', f('pres', 'media', { presPopulated: false }) === true);
    ok('pres: NOT full while presentation active', f('pres', 'media', { presPopulated: true }) === false);
    ok('all: full when all layers off', f('all', 'media', { allOff: true }) === true);
    ok('all: not full when a layer on', f('all', 'media', { allOff: false }) === false);
    ok('layer: full when chosen layer off', f('layer', 'media', { layers: { media: false } }) === true);
    ok('layer: not full when chosen layer on', f('layer', 'media', { layers: { media: true } }) === false);
    ok('manual: never a full clear', f('manual', 'media', { presPopulated: false, allOff: true }) === false);
  } else { ok('isFullClear is accessible', false); }

  // connect (default rule is now "pres" = presentation-cleared detection)
  const ip = D.querySelector('input[placeholder="192.168.1.100"]'); ip.value = '127.0.0.1'; ip.dispatchEvent(new W.Event('input', { bubbles: true }));
  click(btnByText(/Connect/));

  // accumulate two verses while live
  slideText = 'John 3:16\nFor God so loved the world.'; slideActive = true; presActive = true; layersObj = Object.assign({}, VERSE); await sleep(400);
  slideText = 'Romans 8:28\nAnd we know.'; await sleep(400);
  ok('verses accumulate while live', pgList().includes('John 3:16') && pgList().includes('Romans 8:28'));
  ok('header shown while the list has items', pgHeadingShown());

  // F2 (Clear Slide) as ProPresenter actually reports it: slide off, MEDIA STILL ON,
  // presentation cleared. Not a full clear -> the header stays.
  const CLEAR_SLIDE = Object.assign({}, ALL_OFF, { media: true });
  slideText = ''; slideActive = false; presActive = false; layersObj = Object.assign({}, CLEAR_SLIDE); await sleep(700);
  ok('F2: list CLEARS', pgList().length === 0);
  ok('F2: header STAYS up (media still on -> not a full clear)', pgHeadingShown());

  // re-populate, then F1 (Clear All): presentation cleared
  slideText = 'Psalm 23:1\nThe Lord is my shepherd.'; slideActive = true; presActive = true; layersObj = Object.assign({}, VERSE); await sleep(400);
  ok('list repopulates after a new verse', pgList().includes('Psalm 23:1'));
  slideText = ''; slideActive = false; presActive = false; layersObj = Object.assign({}, ALL_OFF); await sleep(700);
  ok('F1: list CLEARS', pgList().length === 0);
  ok('F1: header HIDES (presentation cleared)', !pgHeadingShown());

  // ---- manual "Clear scripture list now": with auto-clear OFF, the list persists through a clear, then the button empties it ----
  selType('history');
  const tog = [...D.querySelectorAll('.secbody .sw')].find(s => /Clear All \(F1\)/i.test(s.textContent));
  const box = tog && tog.querySelector('input[type=checkbox]');
  if (box) { box.checked = false; box.dispatchEvent(new W.Event('change', { bubbles: true })); }
  click(D.getElementById('btnTrans'));   // Take so the clearOnAll=off setting reaches the program the poller checks
  slideText = 'Isaiah 40:31\nThey shall mount up.'; slideActive = true; presActive = true; layersObj = Object.assign({}, VERSE); await sleep(400);
  slideText = ''; slideActive = false; presActive = false; layersObj = Object.assign({}, ALL_OFF); await sleep(400);   // cleared; auto-clear OFF so it persists
  ok('auto-clear OFF: list persists through a clear', pgList().includes('Isaiah 40:31'));
  click(btnByText(/Clear scripture list now/i)); await sleep(700);
  ok('manual Clear list empties the list', pgList().length === 0);

  /* ---------------- the one-time clearRule migration (was untested) ----------------
     migrateClearRule() rewrites a saved setting on EVERY load, for every existing
     install, and had no coverage at all. The case that matters most is (c): an operator
     who deliberately chose "pres" must keep it — silently overriding a deliberate
     choice would be worse than the bug the migration exists to fix.
     Case (b) is Brandon's real stored config, read out of his running app on 1.3.3. */
  {
    const M = W.migrateClearRule;
    ok('migration: reachable', typeof M === 'function');

    const fresh = W.defaultConfig();
    ok('migration: a new config already defaults to "all"', fresh.conn.clearRule === 'all');

    // (b) a config saved by v1.3.1 — "pres" with no migration flags
    const stored = { conn: { host: '', port: 1025, pollMs: 200, clearRule: 'pres', clearLayer: 'media' } };
    M(stored);
    ok('migration: a stored "pres" flips to "all" and stamps _ruleMig2',
       stored.conn.clearRule === 'all' && stored.conn._ruleMig2 === true);

    // (c) an explicit operator pick sets _ruleMig and must survive
    const chosen = { conn: { clearRule: 'pres', _ruleMig: true } };
    M(chosen);
    ok('migration: a DELIBERATE "pres" pick is preserved', chosen.conn.clearRule === 'pres');

    // (d) idempotent — repeated loads must not thrash the value
    const twice = { conn: { clearRule: 'pres' } };
    M(twice); const afterFirst = twice.conn.clearRule; M(twice); M(twice);
    ok('migration: idempotent across repeated loads',
       afterFirst === 'all' && twice.conn.clearRule === 'all');

    // (e) the other rules are none of its business
    const layer = { conn: { clearRule: 'layer' } }, manual = { conn: { clearRule: 'manual' } },
          all = { conn: { clearRule: 'all' } };
    M(layer); M(manual); M(all);
    ok('migration: leaves "layer"/"manual"/"all" alone',
       layer.conn.clearRule === 'layer' && manual.conn.clearRule === 'manual' && all.conn.clearRule === 'all');

    let threw = false;
    try { M(null); M(undefined); M({}); M({ conn: null }); } catch (e) { threw = true; }
    ok('migration: a malformed config does not throw', !threw);
  }

  console.log('CLEAR-RULE RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 6)) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('**FAIL** THREW: ' + e.message); console.log('CLEAR-RULE RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW'); process.exit(1); });
