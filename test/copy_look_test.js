// "Match other layers": copy one layer's look onto the layers the operator picks.
//
// The contract under test, in order of what it would cost on a Sunday if broken:
//   1. Paste NEVER touches content, geometry, name, id, the ProPresenter binding, or the
//      source. Pasting geometry stacks every element on one spot; pasting a binding puts
//      four elements on the same slide. These are the two ways the feature could ruin a
//      service instead of saving time, so they are asserted per-field.
//   2. Same-type paste is exact: box shape, anim, loop, text styles all land.
//   3. Cross-type paste maps text styles by ROLE (primary/secondary), so a Scripture's
//      verse-body typography lands on a Name's name line — a key-by-key copy would
//      silently do nothing between different types, which is the operator's likeliest use.
//   4. Only the TICKED layers receive the paste ("per layer that i select").
//   5. A ticker/credits-roll motion pasted onto a type that cannot scroll lands as "none"
//      rather than a motion the element can never perform.
//   6. Copy/paste state survives the renderPanels() rebuild between the copy click and the
//      paste click (the buffer lives outside secInspector).
const { JSDOM } = require('jsdom');
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'lt.html'), 'utf8');
const errors = [];
const stubs = (w) => {
  w.ResizeObserver = class { observe() {} };
  w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
  w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
  w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
};
// `preview` is block-scoped inside the console bootstrap, so the model cannot be reached
// from outside after boot. Instead: a throwaway FIRST boot supplies the real factories
// (createElement/defaultConfig), which build a config whose SOURCE layer already carries
// distinctive styling; the second boot — the one under test — starts from that config via
// localStorage, exactly as a real console restores a saved session.
const factory = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse: stubs });
const seed = (() => {
  const FW = factory.window;
  const cfg = FW.defaultConfig();               // scripture + history
  ['name', 'sermonTitle', 'qr'].forEach(t => cfg.elements.push(FW.createElement(t)));
  const src = cfg.elements.find(e => e.type === 'scripture');
  src.box.fill1 = '#123456'; src.box.accentColor = '#ff0000'; src.box.radius = 33; src.box.style = 'solid';
  src.box.mediaSrc = 'data:image/png;base64,AAAA'; src.box.mediaType = 'image';
  src.anim.in = 'zoom-in'; src.anim.durIn = 777;
  src.loop.type = 'ticker'; src.loop.speed = 12;
  src.style.body.font = 'Impact,sans-serif'; src.style.body.size = 61; src.style.body.color = '#00ff00';
  src.style.ref.size = 19; src.style.ref.color = '#aa00aa';
  src.ppMatch = 'G:Bot Lower 3rds';
  return JSON.stringify(cfg);
})();
errors.length = 0;   // the factory boot's noise is not under test

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { stubs(w); w.localStorage.setItem('pplt.preview.v2', seed); }
});
const W = dom.window, D = W.document;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = (n) => { if (!n) throw new Error('node not found'); n.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
const btnByText = (re) => [...D.querySelectorAll('#panels button')].find(b => re.test(b.textContent));
const selRow = (ty) => { const row = [...D.querySelectorAll('.elrow')].find(r => r.querySelector('.ty') && r.querySelector('.ty').textContent === ty); if (!row) throw new Error('no row ' + ty); click(row.querySelector('.nm')); };
let pass = 0, fail = 0; const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

(async () => {
  await sleep(300);
  const cfgEls = () => JSON.parse(W.localStorage.getItem('pplt.preview.v2')).elements;

  // Copy from the scripture layer
  selRow('scripture'); await sleep(80);
  click(btnByText(/Copy this layer's look/i)); await sleep(120);
  ok('copy shows the picker', !!btnByText(/Select layers above to paste onto/i) || !!btnByText(/Paste onto \d/i));

  // The buffer must survive a full panel rebuild (selecting another layer re-renders)
  selRow('name'); await sleep(80); selRow('scripture'); await sleep(80);
  ok('the copied look survives a panel rebuild', [...D.querySelectorAll('#panels .hint')].some(h => /Copied from/i.test(h.textContent)));

  // Tick ONLY name + qr — sermonTitle stays untouched to prove per-layer selection
  {
    const grp = [...D.querySelectorAll('#panels .grp')].find(g => /Match other layers/i.test(g.textContent));
    const rows = [...grp.querySelectorAll('.ellist label')];
    const tick = (re) => { const r = rows.find(x => re.test(x.textContent)); const cb = r && r.querySelector('input'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new W.Event('change', { bubbles: true })); } };
    tick(/Name/i); tick(/QR/i);
    click(grp.querySelector('button.primary'));
  }
  await sleep(150);

  const els = cfgEls();
  const name = els.find(e => e.type === 'name');
  const sermon = els.find(e => e.type === 'sermonTitle');
  const qr = els.find(e => e.type === 'qr');
  const nameBefore = JSON.parse(seed).elements.find(e => e.type === 'name');   // as seeded, pre-paste

  // 2. same box shape lands on the ticked layers
  ok('box fill pastes onto Name', name.box.fill1 === '#123456');
  ok('box accent pastes onto Name', name.box.accentColor === '#ff0000');
  ok('box radius pastes onto Name', name.box.radius === 33);
  ok('media pastes onto Name', name.box.mediaSrc === 'data:image/png;base64,AAAA');
  ok('anim pastes onto Name', name.anim.in === 'zoom-in' && name.anim.durIn === 777);
  // 3. cross-type role mapping: scripture.body (primary) -> name.name; scripture.ref (secondary) -> name.title
  ok('primary text style maps body->name', name.style.name.font === 'Impact,sans-serif' && name.style.name.size === 61 && name.style.name.color === '#00ff00');
  ok('secondary text style maps ref->title', name.style.title.size === 19 && name.style.title.color === '#aa00aa');
  // 5. ticker cannot land on a QR code
  ok('ticker lands as "none" on the QR element', qr.loop.type === 'none');
  ok('...but the box shape still pastes onto it', qr.box.fill1 === '#123456');
  // 4. the unticked layer is untouched
  ok('unticked Sermon title keeps its own box', sermon.box.fill1 !== '#123456');
  ok('unticked Sermon title keeps its own text style', sermon.style.title.font !== 'Impact,sans-serif');
  // 1. the never-copied fields
  ok('paste does not move the element', name.layout.x === nameBefore.layout.x && name.layout.y === nameBefore.layout.y && name.layout.w === nameBefore.layout.w);
  ok('paste does not rename it', (name.name || '') === (nameBefore.name || ''));
  ok('paste does not touch its content', name.content.name === nameBefore.content.name);
  ok('paste does not copy the ProPresenter binding', (name.ppMatch || '') === '');
  ok('paste does not change the source kind', name.source.kind === 'manual');
  // and the paste is a CLONE, not a shared object — edit the TARGET's fill through the real
  // inspector and prove the SOURCE did not move. This is also the end-to-end check for the
  // user's core ask: adjusting one layer's colour only updates that layer.
  {
    selRow('name'); await sleep(100);
    const grp = [...D.querySelectorAll('#panels .grp')].find(g => /Background shape/i.test(g.querySelector('.gh').textContent));
    const fillRow = [...grp.querySelectorAll('label.fld')].find(l => l.textContent === 'Fill');
    const txt = fillRow.parentElement.querySelector('.cw input[type=text]');
    txt.value = '#000001'; txt.dispatchEvent(new W.Event('input', { bubbles: true }));
    await sleep(120);
    const after = cfgEls();
    ok('editing the pasted fill changes only that layer', after.find(e => e.type === 'name').box.fill1 === '#000001');
    ok('...the source layer keeps its own colour', after.find(e => e.type === 'scripture').box.fill1 === '#123456');
    ok('...and the other pasted layer keeps its copy', after.find(e => e.type === 'qr').box.fill1 === '#123456');
  }

  ok('no console errors', errors.length === 0);
  console.log('COPY-LOOK RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 5)) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('**FAIL** THREW: ' + e.message); console.log('COPY-LOOK RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW'); process.exit(1); });
