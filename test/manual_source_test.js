// Manual-source content rendering on the OBS output page.
//
// Scripture and Reference both offer a "Manual" Source in the inspector, which writes the
// operator's typed verse into d.content. They used to read only from the live-feed `data`
// object, so a manual Scripture/Reference composited an EMPTY box on air.
//
// The guard matters as much as the fix. Every element is created carrying a placeholder
// verse ("John 3:16 / For God so loved the world...") in d.content, and a non-scripture
// slide legitimately produces live data of {ref:"", body:<slide text>}. With "Only show on
// scripture slides" turned OFF, an unguarded d.content fallback would paint John 3:16 next
// to an announcement slide. So: fall back for MANUAL elements only, never for LIVE ones.
const { JSDOM } = require('jsdom');
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'lt.html'), 'utf8');

const errors = [];
let sseInst = null, slideText = '', slideActive = true;
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/output', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor(u) { this.url = u; sseInst = this; setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      const url = String(u);
      if (/active/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation: { id: { uuid: 'x', name: 'Deck', index: 0 } } }) });
      if (/layers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ slide: slideActive, media: true }) });
      if (/slide/.test(url))  return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const pushSSE = (cfg) => { if (sseInst && sseInst.onmessage) sseInst.onmessage({ data: JSON.stringify({ type: 'program', cfg }) }); };
const { onAirText } = require('./_onair');
// painted text only — see test/_onair.js
const outText = () => onAirText(D, W);
const manual = (type, content) => { const e = W.createElement(type); e.source = { kind: 'manual' }; e.content = content; return e; };
const withConn = (cfg) => { cfg.conn = Object.assign({}, cfg.conn, { host: '127.0.0.1', port: 1025, pollMs: 200 }); return cfg; };

(async () => {
  await sleep(120);
  ok('output page booted', D.body.classList.contains('output'));

  /* ---------- 1. manual source renders what the operator typed ---------- */
  let cfg = W.defaultConfig();
  cfg.elements = [
    manual('scripture', { ref: 'Psalm 23:1', translation: 'ESV', body: 'The LORD is my shepherd; I shall not want.' }),
    manual('reference', { ref: 'Romans 8:28', translation: 'NIV' }),
    manual('name',      { name: 'Pastor Mike Reynolds', title: 'Lead Pastor' }),
    manual('text',      { text: 'Welcome home' }),
  ];
  cfg._take = 1;
  pushSSE(cfg); await sleep(300);

  ok('manual scripture renders its reference',   /Psalm 23:1/.test(outText()));
  ok('manual scripture renders its translation', /ESV/.test(outText()));
  ok('manual scripture renders its verse body',  /I shall not want/.test(outText()));
  ok('manual reference renders its reference',   /Romans 8:28/.test(outText()));
  ok('manual reference renders its translation', /NIV/.test(outText()));
  ok('manual name still renders (unchanged)',    /Pastor Mike Reynolds/.test(outText()));
  ok('manual text still renders (unchanged)',    /Welcome home/.test(outText()));
  ok('no element composites as an empty box',
     [...D.querySelectorAll('#out-scaler .lt-el')].filter(e => !(e.textContent || '').trim()).length === 0);

  /* ---------- 2. a manual element left blank must not leak the placeholder ---------- */
  cfg = W.defaultConfig();
  cfg.elements = [manual('scripture', { ref: '', translation: '', body: '' })];
  cfg._take = 2;
  pushSSE(cfg); await sleep(300);
  ok('blank manual scripture shows no placeholder verse', !/John 3:16|God so loved/.test(outText()));

  /* ---------- 3. THE GUARD: a live element must never fall back to d.content ---------- */
  const fresh = W.createElement('scripture');
  ok('sanity: a new scripture carries the John 3:16 placeholder in d.content',
     /John 3:16/.test(fresh.content.ref || ''));

  const liveEl = W.createElement('scripture');
  liveEl.source = { kind: 'live', requireRef: false };   // "Only show on scripture slides" OFF
  cfg = withConn(W.defaultConfig());
  cfg.elements = [liveEl];
  cfg._take = 3;
  pushSSE(cfg); await sleep(150);

  // A NON-scripture slide -> live data is {ref:"", body:<slide text>}.
  slideText = 'Fellowship Lunch Today\nJoin us in the hall right after service';
  await sleep(500);
  ok('live scripture shows the announcement slide body', /Fellowship Lunch Today|right after service/.test(outText()));
  ok('GUARD: live element does NOT paint the John 3:16 placeholder reference',
     !/John 3:16/.test(outText()));
  ok('GUARD: live element does NOT paint the placeholder verse body',
     !/God so loved the world/.test(outText()));

  // A real scripture slide -> the LIVE reference wins, still no placeholder.
  slideText = 'Isaiah 40:31 NIV\nBut those who hope in the LORD will renew their strength.';
  await sleep(500);
  ok('live scripture renders the live reference', /Isaiah 40:31/.test(outText()));
  ok('live scripture renders the live translation', /NIV/.test(outText()));
  ok('live scripture renders the live body', /renew their strength/.test(outText()));
  ok('GUARD: still no placeholder leaking through on a live verse', !/John 3:16/.test(outText()));

  console.log('\nMANUAL-SOURCE RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? errors.slice(0, 3).join(' | ') : 'NONE'));
  process.exit(0);
})();
