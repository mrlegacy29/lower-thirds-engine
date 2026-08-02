// Regressions for the second audit pass. Each of these was a CONFIRMED defect in code
// written the same day, so they get pinned.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
let sseInst = null;
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/output', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { sseInst = this; setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    // Serve the bound data source for real, so {{placeholders}} are exercised through
    // the ACTUAL feed path (createDataFeed -> parseDataSource -> setVars -> render)
    // rather than by poking the stage directly.
    w.fetch = (u) => {
      const s = String(u);
      if (/\/fetch\?/.test(s)) return Promise.resolve({ ok: true, text: () => Promise.resolve('v,VALUE') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = dom.window.document;
const push = (cfg) => { if (sseInst && sseInst.onmessage) sseInst.onmessage({ data: JSON.stringify({ type: 'program', cfg }) }); };
const out = () => (D.querySelector('#out-scaler') || {}).textContent || '';
let take = 4000;

setTimeout(async () => {
  /* ---- a countdown that has passed must NOT roll to ~24h ---- */
  {
    const now = new Date(2026, 7, 1, 11, 0, 30);
    ok('countdown: 30s past the target is -30, not ~86370',
       W.secsUntilClock('11:00', now) === -30);
    ok('countdown: 90s past is -90 (the old +86400 roll is gone)',
       W.secsUntilClock('11:00', new Date(2026, 7, 1, 11, 1, 30)) === -90);
    ok('countdown: a future target still counts down normally',
       W.secsUntilClock('11:30', now) === (29 * 60 + 30));
    ok('countdown: an impossible time is rejected', W.secsUntilClock('99:99', now) === null);
  }

  /* ---- imported looks must keep their automation rules wired ---- */
  {
    const file = {
      format: 'lower-thirds-engine', version: 1, kind: 'look',
      config: {
        elements: [
          { id: 'old-a', type: 'text', name: 'Banner' },
          { id: 'old-b', type: 'scripture', name: 'Verse' },
        ],
        rules: [
          { id: 'r1', enabled: true, on: 'text', match: 'contains', pattern: 'Welcome', act: 'show', target: 'old-a' },
          { id: 'r2', enabled: true, on: 'text', match: 'contains', pattern: 'x', act: 'show', target: 'GONE' },
        ],
      },
    };
    const r = W.parseGfx(JSON.stringify(file));
    ok('import: the look parses', r.ok && r.kind === 'look');
    const els = r.ok ? r.payload.config.elements : [];
    const rules = r.ok ? r.payload.config.rules : [];
    const banner = els.find(e => e.name === 'Banner');
    ok('import: rules survive the import at all', rules.length === 2);
    ok('import: a rule target is REMAPPED to the element\'s new id',
       !!banner && rules[0].target === banner.id && banner.id !== 'old-a');
    ok('import: a DANGLING rule target is nulled, not left pointing at a dead id',
       rules[1].target === null);
    ok('import: rules get fresh ids too', rules[0].id !== 'r1');
    // and the remapped rule actually drives visibility
    const state = W.evalRules(rules, { text: 'Welcome home', cleared: false });
    ok('import: the remapped rule controls the real element', state[banner.id] === true);
  }

  /* ---- a wrong-TYPE value in an imported file must not reach the renderer ---- */
  {
    const r = W.parseGfx(JSON.stringify({
      kind: 'element',
      element: { type: 'text', name: 'X', style: { text: { color: { nope: 1 }, size: 'huge' } } },
    }));
    ok('import: an element with wrong-typed style values still parses', r.ok);
    const c = r.ok ? r.payload.style.text.color : null;
    ok('import: a non-string colour is rejected, default kept', typeof c === 'string');
    ok('import: a non-number size is rejected, default kept', typeof r.payload.style.text.size === 'number');
  }

  /* ---- {{placeholders}} must reach EVERY operator-typed field ---- */
  {
    const cfg = W.defaultConfig();
    const mk = (type, content, extra) => {
      const e = W.createElement(type);
      e.source = { kind: 'manual' };
      Object.assign(e.content, content);
      if (extra) Object.assign(e, extra);
      return e;
    };
    cfg.elements = [
      mk('text', { text: 'T {{v}}' }),
      mk('sermonTitle', { title: 'Title {{v}}', sub: 'Sub {{v}}' }),
      mk('bulletList', { heading: 'Head {{v}}', bullets: 'Item {{v}}' }),
      mk('clock', { mode: 'time', label: 'Lbl {{v}}' }),
      mk('qr', { text: 'https://x.example/{{v}}', label: 'SCAN {{v}}' }),
      mk('eventList', { items: 'Ev {{v}}' }),
      mk('name', { name: 'N', title: 'Role {{v}}' }),
    ];
    // a real bound source, resolved through the live feed
    cfg.data = { sources: [{ id: 's1', enabled: true, name: '', url: 'http://example.test/sheet.csv', kind: 'csv', interval: 60 }] };
    cfg._take = ++take;
    push(cfg);
    await sleep(900);                    // let the feed fetch, parse and re-render
    const t = out();
    const chk = (label, needle) => ok('placeholders: ' + label + ' resolves',
      t.indexOf(needle) >= 0 && t.indexOf('{{v}}') < 0);
    chk('text element', 'T VALUE');
    chk('sermon title', 'Title VALUE');
    chk('sermon subtitle', 'Sub VALUE');
    chk('bullet heading', 'Head VALUE');
    chk('bullet item', 'Item VALUE');
    chk('clock label', 'Lbl VALUE');
    chk('QR caption', 'SCAN VALUE');
    chk('event list item', 'Ev VALUE');
    chk('name role line', 'Role VALUE');
    ok('placeholders: no raw {{v}} left anywhere on air', t.indexOf('{{') < 0);
  }

  /* ---- QR must not throw on a lone surrogate ---- */
  {
    let threw = false, res;
    try { res = W.qrEncode('give \uD83D'); } catch (e) { threw = true; }
    ok('QR: a lone surrogate does not throw', !threw);
    ok('QR: it still produces a code', !!res);
  }

  /* ---- leaving ticker mode after an EMPTY ticker must not throw ---- */
  {
    const cfg = W.defaultConfig();
    const e = W.createElement('eventList');
    e.source = { kind: 'manual' };
    e.content.items = '';                 // nothing to scroll
    e.loop = { type: 'ticker', speed: 20 };
    cfg.elements = [e]; cfg._take = ++take;
    push(cfg); await sleep(300);
    const before = errors.length;
    e.loop = { type: 'none' };            // leave ticker mode
    e.content.items = 'Now has content';
    const cfg2 = JSON.parse(JSON.stringify(cfg)); cfg2.elements = [e]; cfg2._take = ++take;
    push(cfg2); await sleep(350);
    ok('ticker: leaving an EMPTY ticker does not throw', errors.length === before);
    ok('ticker: content renders after leaving ticker mode', /Now has content/.test(out()));
  }

  ok('nothing threw overall', errors.length === 0);
  console.log('\nAUDIT-FIXES RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? errors.slice(0, 3).join(' | ') : 'NONE'));
  process.exit(fail ? 1 : 0);
}, 500);
