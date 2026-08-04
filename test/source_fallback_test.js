// Which source each element type reads from, and what must never leak on air.
//
// manual_source_test.js covers the v1.0.5 fix for the STATIC render path. This suite covers
// the two gaps that were left:
//
//   1. The TICKER / CREDITS-ROLL path. setText() early-returns into renderMarquee() before
//      manualContent() ever runs, and marqText() had no d.content fallback for scripture or
//      reference — so a manual Scripture set to Motion = Ticker scrolled nothing but the
//      separator diamonds. Every assertion below therefore runs TWICE: once static, once
//      with a ticker, because the two paths render completely different DOM.
//
//   2. NAME and TEXT had the mirror-image of the v1.0.5 bug: in LIVE mode they still fell
//      back to d.content, so a blank slide painted the factory placeholders
//      ("Pastor Mike Reynolds", "Custom text") on air.
//
// The name rule is deliberately ASYMMETRIC — do not "fix" it into a plain guard:
//   NAME  never falls back when live (a blank slide has no name to show).
//   TITLE falls back to the configured "Title / role" when the slide supplies no second
//         line, because it doubles as a standing role label. That fallback is gated on a
//         live name existing, so a blank slide still paints nothing at all. The inspector
//         exposes the field in Live mode so it is a visible choice, not a hidden default.
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
const { onAirText } = require('./_onair');
// PAINTED text only — textContent counts elements the engine has taken off air, so this
// used to pass for graphics composited fully transparent into the OBS source.
const out = () => onAirText(D, W);
const pushSSE = (cfg) => { if (sseInst && sseInst.onmessage) sseInst.onmessage({ data: JSON.stringify({ type: 'program', cfg }) }); };
let pass = 0, fail = 0, take = 200;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
// every element here is live-capable, so the config always carries a connection
const put = (els) => {
  const cfg = W.defaultConfig();
  cfg.conn = Object.assign({}, cfg.conn, { host: '127.0.0.1', port: 1025, pollMs: 200 });
  cfg.elements = els; cfg._take = ++take; pushSSE(cfg);
};
const mk = (type, source, loop, content) => {
  const e = W.createElement(type); e.source = source; e.loop = loop;
  if (content) e.content = content;
  return e;
};

(async () => {
  await sleep(150);
  ok('output page booted', D.body.classList.contains('output'));

  // The ticker rebuilds the DOM through renderMarquee() instead of setText(), so every
  // rule has to be asserted in both modes or a fix in one path can silently miss the other.
  for (const mode of ['none', 'ticker']) {
    const L = mode === 'ticker' ? 'ticker: ' : 'static: ';
    const loop = { type: mode, speed: 40 };

    /* ---------- manual source: the operator's typed content still renders ---------- */
    put([
      mk('scripture', { kind: 'manual' }, loop, { ref: 'Psalm 23:1', translation: 'ESV', body: 'The LORD is my shepherd' }),
      mk('reference', { kind: 'manual' }, loop, { ref: 'Romans 8:28', translation: 'NIV' }),
      mk('name',      { kind: 'manual' }, loop, { name: 'Pastor Mike Reynolds', title: 'Lead Pastor' }),
      mk('text',      { kind: 'manual' }, loop, { text: 'Welcome home' }),
    ]);
    await sleep(450);
    ok(L + 'manual scripture renders its verse body', /my shepherd/.test(out()));
    ok(L + 'manual reference renders its reference',  /Romans 8:28/.test(out()));
    ok(L + 'manual name renders',                     /Pastor Mike Reynolds/.test(out()));
    ok(L + 'manual name renders its title',           /Lead Pastor/.test(out()));
    ok(L + 'manual text renders',                     /Welcome home/.test(out()));

    /* ---------- live name: slide wins, role label is the only fallback ---------- */
    put([mk('name', { kind: 'live' }, loop)]);
    await sleep(250);

    slideText = 'Pastor Dave Ellis\nGuest Speaker';
    await sleep(500);
    ok(L + 'live name, 2-line slide: name from the slide', /Pastor Dave Ellis/.test(out()));
    ok(L + 'live name, 2-line slide: role from the slide', /Guest Speaker/.test(out()));
    ok(L + 'live name, 2-line slide: configured role does NOT override', !/Lead Pastor/.test(out()));

    slideText = 'Pastor Dave Ellis';
    await sleep(500);
    ok(L + 'live name, 1-line slide: name from the slide', /Pastor Dave Ellis/.test(out()));
    ok(L + 'live name, 1-line slide: standing role label IS used', /Lead Pastor/.test(out()));

    slideText = '   \n   ';
    await sleep(500);
    ok(L + 'live name, blank slide: no placeholder name leaks', !/Pastor Mike Reynolds/.test(out()));
    ok(L + 'live name, blank slide: no orphan role label',      !/Lead Pastor/.test(out()));

    /* ---------- live name with the role label cleared by the operator ---------- */
    put([mk('name', { kind: 'live' }, loop, { name: '', title: '' })]);
    await sleep(250);
    slideText = 'Pastor Dave Ellis';
    await sleep(500);
    ok(L + 'live name, role cleared: name still renders',  /Pastor Dave Ellis/.test(out()));
    ok(L + 'live name, role cleared: no role label at all', !/Lead Pastor/.test(out()));

    /* ---------- live text ---------- */
    put([mk('text', { kind: 'live' }, loop)]);
    await sleep(250);
    slideText = 'Welcome to Victory Church';
    await sleep(500);
    ok(L + 'live text renders the raw slide', /Welcome to Victory Church/.test(out()));
    slideText = '   \n   ';
    await sleep(500);
    ok(L + 'live text, blank slide: no "Custom text" placeholder leaks', !/Custom text/.test(out()));

    /* ---------- the v1.0.5 scripture guard still holds in BOTH paths ---------- */
    put([mk('scripture', { kind: 'live', requireRef: false }, loop)]);
    await sleep(250);
    slideText = 'Fellowship Lunch Today\nJoin us in the hall';
    await sleep(500);
    ok(L + 'v1.0.5 guard: live scripture shows the announcement slide', /Fellowship Lunch|in the hall/.test(out()));
    ok(L + 'v1.0.5 guard: no John 3:16 placeholder reference',          !/John 3:16/.test(out()));
    ok(L + 'v1.0.5 guard: no placeholder verse body',                   !/God so loved the world/.test(out()));
    slideText = '';
    await sleep(500);
  }

  /* ================= the other half of the chain: the BUILDER inspector =================
     The render rules above only hold if the operator can actually SEE and edit the standing
     role label. It used to be hidden whenever Source was Live, so the factory default could
     go on air under a guest speaker with no way to notice or clear it. This boots a second
     jsdom on the builder page (the output page has no inspector) and asserts the contract.  */
  await builderInspector();

  console.log('\nSOURCE-FALLBACK RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? errors.slice(0, 3).join(' | ') : 'NONE'));
  process.exit(fail ? 1 : 0);
})();

async function builderInspector() {
  const bdom = new JSDOM(html, {
    url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} };
      w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
      w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      w.console.error = (...a) => errors.push('ERR:' + a.join(' ')); w.onerror = (m) => errors.push('ON:' + String(m));
    }
  });
  const w = bdom.window, d = w.document;
  const click = (n) => n && n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const addBtn = (t) => [...d.querySelectorAll('.addmenu button')].find(b => b.textContent.trim() === '+ ' + t);
  const rowByType = (ty) => [...d.querySelectorAll('.elrow')]
    .find(r => r.querySelector('.ty') && r.querySelector('.ty').textContent === ty);
  const contentGroup = () => [...d.getElementById('panels').querySelectorAll('.grp')]
    .find(g => { const h = g.querySelector('.gh'); return h && h.textContent.trim() === 'Content'; });
  // direct child rows only -- the "Name style"/"Title style" sub-groups also contain a text
  // input (the font name), so a loose querySelector would match those instead.
  const fieldByLabel = (label) => {
    const g = contentGroup(); if (!g) return null;
    const row = [...g.children].find(ch => !ch.classList.contains('grp') && !ch.classList.contains('gh') &&
      (ch.textContent || '').trim().startsWith(label));
    return row ? row.querySelector('input[type=text]') : null;
  };
  const nameEl = () => {
    let s = {}; try { s = JSON.parse(w.localStorage.getItem('pplt.preview.v2')) || {}; } catch (e) {}
    return (s.elements || []).find(e => e && e.type === 'name') || {};
  };

  await sleep(300);
  if (!rowByType('name')) click(addBtn('Name/title'));
  await sleep(50);
  click(rowByType('name'));
  await sleep(80);

  ok('inspector/manual: "Name" field present', !!fieldByLabel('Name'));
  ok('inspector/manual: "Title / role" field present', !!fieldByLabel('Title / role'));

  const liveBtn = [...d.getElementById('panels').querySelectorAll('.seg button')]
    .find(b => /Live \(current slide lines\)/.test(b.textContent));
  ok('inspector: found the Live source button', !!liveBtn);
  click(liveBtn); await sleep(120);

  ok('inspector/live: "Name" field hidden (the slide supplies it)', !fieldByLabel('Name'));
  const rf = fieldByLabel('Title / role');
  ok('inspector/live: "Title / role" is VISIBLE', !!rf);
  ok('inspector/live: prefilled with the configured role', !!rf && rf.value === 'Lead Pastor');
  ok('inspector/live: explanatory hint shown', /only one line/.test(d.getElementById('panels').textContent || ''));

  if (rf) { rf.value = 'Guest Speaker'; rf.dispatchEvent(new w.Event('input', { bubbles: true })); }
  await sleep(150);
  ok('inspector/live: edit survives the panel re-render', (fieldByLabel('Title / role') || {}).value === 'Guest Speaker');
  ok('inspector/live: edit landed on d.content.title', (nameEl().content || {}).title === 'Guest Speaker');
  ok('inspector/live: element is still source=live', ((nameEl().source) || {}).kind === 'live');
  ok('inspector/live: d.content.name was not clobbered', typeof (nameEl().content || {}).name === 'string');

  const rf2 = fieldByLabel('Title / role');
  if (rf2) { rf2.value = ''; rf2.dispatchEvent(new w.Event('input', { bubbles: true })); }
  await sleep(150);
  ok('inspector/live: role label can be cleared to empty', (nameEl().content || {}).title === '');
}
