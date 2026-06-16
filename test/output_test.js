// Coverage for the OBS Output page (the on-air half OBS renders): the isOutput
// bootstrap, SSE program subscribe (+ partial-config guard), live verse render,
// and the output page's OWN F1-vs-F2 history clear.
const { JSDOM } = require('jsdom');
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'lt.html'), 'utf8');
const errors = [];
let slideText = '', slideActive = true, layersObj = null, sseInst = null, presActive = true;
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/output', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor(u) { this.url = u; sseInst = this; setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.prompt = () => 'P'; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      const url = String(u);
      if (/active/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation: presActive ? { id: { uuid: 'x', name: 'Deck', index: 0 } } : null }) });
      if (/layers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve(layersObj || { slide: slideActive, media: true }) });
      if (/slide/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const outWrap = (sel) => [...D.querySelectorAll('#out-scaler .lt-el')].find(x => x.querySelector(sel));
const outRef = () => { const w = outWrap('.r-ref'); return w ? w.querySelector('.r-ref').textContent : ''; };
const outList = () => { const e = outWrap('.h-items'); return e ? [...e.querySelectorAll('.h-items .h-chip .tx')].map(t => t.textContent) : []; };
const outHeadingShown = () => { const w = outWrap('.h-label'); const h = w && w.querySelector('.h-label'); return !!h && h.style.display !== 'none'; };
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

  // F2 (Clear Slide): presentation still active -> list clears but the header STAYS
  slideText = ''; slideActive = false; presActive = true; layersObj = { slide: false, media: false }; await sleep(700);
  ok('F2: output ref list clears', outList().length === 0);
  ok('F2: output header STAYS (presentation still active)', outHeadingShown());

  // re-populate, then F1 (Clear All): presentation cleared -> list clears AND header hides
  slideText = 'Psalm 23:1\nThe Lord is my shepherd.'; slideActive = true; presActive = true; layersObj = { slide: true, media: false }; await sleep(400);
  ok('output list repopulates', outList().includes('Psalm 23:1'));
  slideText = ''; slideActive = false; presActive = false; layersObj = { slide: false, media: false }; await sleep(700);
  ok('F1: output ref list clears', outList().length === 0);
  ok('F1: output header HIDES (presentation cleared)', !outHeadingShown());

  // a partial/garbage broadcast must not throw on-air (deepMerge guard)
  const errBefore2 = errors.length;
  pushSSE({ _take: 11 }); await sleep(80);
  ok('partial SSE config does not throw on-air', errors.length === errBefore2);

  console.log('OUTPUT RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 6)) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('**FAIL** THREW: ' + e.message); console.log('OUTPUT RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW'); process.exit(1); });
