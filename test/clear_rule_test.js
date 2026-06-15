// Clear Behavior feature: the configurable rule that decides when the
// Previously-Referenced scripture list clears. Proves the "pres" rule
// distinguishes Clear Slide from Clear All even in a slides-only service
// (where /v1/status/layers is identical for both), plus the manual clear.
const { JSDOM } = require('jsdom');
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'lt.html'), 'utf8');
const errors = [];
let slideText = '', slideActive = true, layersObj = null, presPop = true;
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.prompt = () => 'P'; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      const url = String(u);
      if (/slide_index/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation_index: presPop ? { index: 0, presentation_id: { uuid: 'x', name: 'P', index: 0 } } : null }) });
      if (/layers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve(layersObj || { slide: slideActive, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false }) });
      if (/slide/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = (n) => { if (!n) throw new Error('button not found'); n.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
const pgEl = (sel) => [...D.querySelectorAll('#pg-scaler .lt-el')].find(x => x.querySelector(sel));
const pgList = () => { const e = pgEl('.h-items'); return e ? [...e.querySelectorAll('.h-items .h-chip .tx')].map(t => t.textContent) : []; };
const btnByText = (re) => [...D.querySelectorAll('button')].find(b => re.test(b.textContent));
const ALL_OFF = { slide: false, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false };
let pass = 0, fail = 0; const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

(async () => {
  await sleep(300);

  // ---- unit: the rule decision logic ----
  const f = W.isFullClear;
  if (typeof f === 'function') {
    ok('pres: clears when presentation cleared', f('pres', 'media', { presPopulated: false }) === true);
    ok('pres: keeps when presentation still active', f('pres', 'media', { presPopulated: true }) === false);
    ok('all: clears when all layers off', f('all', 'media', { allOff: true }) === true);
    ok('all: keeps when a layer still on', f('all', 'media', { allOff: false }) === false);
    ok('layer: clears when chosen layer off', f('layer', 'media', { layers: { media: false } }) === true);
    ok('layer: keeps when chosen layer on', f('layer', 'media', { layers: { media: true } }) === false);
    ok('manual: never auto-clears', f('manual', 'media', { presPopulated: false, allOff: true }) === false);
  } else { ok('isFullClear is accessible', false); }

  // ---- integration: "pres" rule distinguishes Clear Slide from Clear All in a slides-only service ----
  click(btnByText(/presentation cleared/i));   // set the rule to "pres"
  await sleep(20);
  const ip = D.querySelector('input[placeholder="192.168.1.100"]'); ip.value = '127.0.0.1'; ip.dispatchEvent(new W.Event('input', { bubbles: true }));
  click(btnByText(/Connect/));

  slideText = 'John 3:16\nFor God so loved the world.'; slideActive = true; presPop = true; layersObj = { slide: true, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false }; await sleep(400);
  ok('verse logs while live', pgList().includes('John 3:16'));
  slideText = 'Romans 8:28\nAnd we know.'; await sleep(400);
  ok('second verse logs', pgList().includes('Romans 8:28'));

  // F2 (Clear Slide): slide off, EVERY layer off (slides-only), but presentation STILL active -> list STAYS
  slideText = ''; slideActive = false; presPop = true; layersObj = Object.assign({}, ALL_OFF); await sleep(400);
  ok('pres rule: F2 in a slides-only setup KEEPS the list (presentation still active)', pgList().length > 0 && pgList().includes('John 3:16'));

  // Clear All: presentation cleared -> list CLEARS (same layer state as F2 above)
  presPop = false; await sleep(700);   // allow the list exit animation (~450ms) to finish
  ok('pres rule: Clear All (presentation cleared) WIPES the list', pgList().length === 0);

  // ---- manual "Clear scripture list now" ----
  slideText = 'Psalm 23:1\nThe Lord is my shepherd.'; slideActive = true; presPop = true; layersObj = { slide: true, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false }; await sleep(400);
  ok('list repopulates after a new verse', pgList().includes('Psalm 23:1'));
  slideText = ''; slideActive = false; presPop = true; layersObj = Object.assign({}, ALL_OFF); await sleep(400);   // cleared-slide state (rule keeps list)
  ok('F2 again keeps the repopulated list', pgList().includes('Psalm 23:1'));
  click(btnByText(/Clear scripture list now/i)); await sleep(700);   // allow the list exit animation (~450ms) to finish
  ok('manual Clear list empties the list', pgList().length === 0);

  console.log('CLEAR-RULE RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 6)) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('**FAIL** THREW: ' + e.message); console.log('CLEAR-RULE RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW'); process.exit(1); });
