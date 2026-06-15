// On-air resilience of the ProPresenter poller + scripture parser.
// Locks in: B3 (a transient poll failure must HOLD the verse, not blank it),
// H1 (a transient /layers failure must NOT permanently disable F1 detection),
// and H2 (the parser must not eat the first verse word of a one-line slide).
const { JSDOM } = require('jsdom');
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'lt.html'), 'utf8');
const errors = [];
let slideText = '', slideActive = true, layersObj = null, slideFail = false, layersFail = false;
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.prompt = () => 'P'; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      const url = String(u);
      if (/layers/.test(url)) { if (layersFail) return Promise.reject(new Error('layers blip')); return Promise.resolve({ ok: true, json: () => Promise.resolve(layersObj || { slide: slideActive, media: true }) }); }
      if (/slide/.test(url)) { if (slideFail) return Promise.reject(new Error('slide blip')); return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) }); }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = (n) => { if (!n) throw new Error('not found'); n.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
const pgWrap = () => [...D.querySelectorAll('#pg-scaler .lt-el')].find(x => x.querySelector('.r-body'));
const scriptureRef = () => { const w = pgWrap(); return w ? w.querySelector('.r-ref').textContent : ''; };
const scriptureBody = () => { const w = pgWrap(); const b = w && w.querySelector('.r-body'); return b ? b.textContent : ''; };
const scriptureHidden = () => { const w = pgWrap(); const b = w && w.querySelector('.r-body'); return !b || b.style.opacity === '0' || b.style.display === 'none'; };
const pgEl = (sel) => [...D.querySelectorAll('#pg-scaler .lt-el')].find(x => x.querySelector(sel));
const pgList = () => { const e = pgEl('.h-items'); return e ? [...e.querySelectorAll('.h-items .h-chip .tx')].map(t => t.textContent) : []; };
let pass = 0, fail = 0; const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

(async () => {
  await sleep(300);

  // ---- H2: parser unit checks (parseScripture is a top-level fn => global) ----
  if (typeof W.parseScripture === 'function') {
    const ps = W.parseScripture;
    const a = ps('John 3:16 For God so loved the world.');
    ok('H2: one-line ref parses cleanly', !!a && a.ref === 'John 3:16');
    ok('H2: body keeps its first word "For"', !!a && /^For God so loved/.test(a.body));
    ok('H2: no bogus translation tag', !!a && a.translation === '');
    const b = ps('Romans 8:28 And we know that in all things');
    ok('H2: "And" not eaten as a translation', !!b && /^And we know/.test(b.body) && b.translation === '');
    const c = ps('John 3:16 NIV For God so loved');
    ok('H2: real UPPERCASE translation still parsed', !!c && c.translation === 'NIV' && /^For God so loved/.test(c.body));
    const d = ps('John 3:16\nFor God so loved the world.');
    ok('H2: multi-line verse still parses', !!d && d.ref === 'John 3:16' && /^For God so loved/.test(d.body));
  } else {
    console.log('NOTE  parseScripture not global — covered via live-render checks below instead');
  }

  // ---- connect the live poller ----
  const ip = D.querySelector('input[placeholder="192.168.1.100"]'); ip.value = '127.0.0.1'; ip.dispatchEvent(new W.Event('input', { bubbles: true }));
  click([...D.querySelectorAll('.secbody button')].find(b => /Connect/.test(b.textContent)));

  // one-line slide through the LIVE path: ref clean, first word retained on air
  slideText = 'John 3:16 For God so loved the world.'; slideActive = true; layersObj = { slide: true, media: true }; await sleep(400);
  ok('H2 (live): reference renders clean (no eaten word)', /John 3:16/.test(scriptureRef()) && !/For/.test(scriptureRef()));
  ok('H2 (live): verse body keeps "For God"', /^For God so loved/.test(scriptureBody()));

  slideText = 'Psalm 23:1\nThe Lord is my shepherd.'; await sleep(400);
  ok('verse is live on program', /Psalm 23:1/.test(scriptureRef()) && !scriptureHidden());

  // ---- B3: transient slide-poll failures must HOLD the verse, not blank it ----
  slideFail = true; await sleep(500);
  ok('B3: verse HELD during poll failures (not blanked)', /Psalm 23:1/.test(scriptureRef()) && !scriptureHidden());
  slideFail = false; await sleep(400);
  ok('B3: verse still live after polling recovers', /Psalm 23:1/.test(scriptureRef()) && !scriptureHidden());

  // ---- H1: a transient /layers failure must NOT permanently disable F1 ----
  layersFail = true; await sleep(500); layersFail = false; await sleep(300);
  slideText = 'Isaiah 40:31\nThey shall mount up.'; slideActive = true; layersObj = { slide: true, media: true }; await sleep(400);
  ok('H1 setup: ref list populated', pgList().length > 0);
  slideText = ''; slideActive = false; layersObj = { slide: false, media: false }; await sleep(700);
  ok('H1: F1 Clear-All still wipes the list after a layers blip', pgList().length === 0);

  console.log('PP-RESILIENCE RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 6)) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('**FAIL** THREW: ' + e.message); console.log('PP-RESILIENCE RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW'); process.exit(1); });
