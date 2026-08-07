// The Logo / Slogan layer: a station ident that rides above everything and is deliberately
// OUTSIDE ProPresenter's reach. Brandon's requirement was "it stays up over everything and
// doesn't clear unless it's manually cleared inside the program", with image/video support.
//
// Two halves, and both have to hold:
//   1. ON AIR: no ProPresenter clear may take it down — not Clear Slide, not Clear All.
//   2. The operator's own button must take it down IMMEDIATELY, without a TAKE.
// Half 1 is what makes half 2 load-bearing: if the row is the only way down and the row is
// broken, a logo is stuck on air for the whole service with no way to remove it.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');
const { painted } = require('./_onair');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
let slideText = '', slideActive = true, layersObj = null, presActive = true;
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      const url = String(u);
      if (/active/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation: presActive ? { id: { uuid: 'x', name: 'Deck' } } : null }) });
      if (/layers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve(layersObj || { slide: slideActive, media: true }) });
      if (/slide/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    try { w.localStorage.setItem('pplt.preview.v2',
      JSON.stringify({ conn: { host: '127.0.0.1', port: 1025, pollMs: 200 } })); } catch (e) {}
    w.console.error = (...a) => errors.push(a.join(' '));
    w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const click = (n) => { if (!n) throw new Error('control missing'); n.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
const addBtn = (t) => [...D.querySelectorAll('.addmenu button')].find(b => b.textContent.trim() === '+ ' + t);
const rowByType = (ty) => [...D.querySelectorAll('.elrow')].find(r => r.querySelector('.ty') && r.querySelector('.ty').textContent === ty);
const logoBtns = () => [...D.querySelectorAll('#logoBtns button')];
const logoRowShown = () => { const r = D.getElementById('logoRow'); return !!r && r.style.display !== 'none'; };
const inputByLabel = (re) => [...D.querySelectorAll('#panels div')].map(d => {
  const l = d.querySelector(':scope > label.fld'), i = d.querySelector(':scope > input[type=text]');
  return (l && i && re.test(l.textContent)) ? i : null; }).find(Boolean);
// Painted text on a stage, so "on air" means visible rather than merely present in the DOM.
const stageText = (id) => { const root = D.getElementById(id); if (!root) return '';
  const out = []; const wk = D.createTreeWalker(root, W.NodeFilter.SHOW_TEXT, null); let n;
  while ((n = wk.nextNode())) { const t = (n.nodeValue || '').trim(); if (t && painted(n.parentElement, W, D)) out.push(t); }
  return out.join(' '); };
const setText = (inp, v) => { inp.value = v; inp.dispatchEvent(new W.Event('input', { bubbles: true }));
  inp.dispatchEvent(new W.Event('change', { bubbles: true })); };

(async () => {
  await sleep(700);

  /* ---- it is offered, and adding one does not immediately put a plate on air ---- */
  ok('the Logo / Slogan layer can be added', !!addBtn('Logo / Slogan'));
  ok('no logo row while no logo exists', !logoRowShown());
  click(addBtn('Logo / Slogan'));
  await sleep(120);
  const row = rowByType('logo');
  ok('a logo element is created', !!row);
  ok('the operator row appears', logoRowShown());
  ok('...listing it as not yet taken', /press Take/i.test(logoBtns().map(b => b.textContent).join(' ')));

  /* ---- give it content, then take it ---- */
  click(row.querySelector('.nm')); await sleep(80);
  const tIn = inputByLabel(/Logo text/i), sIn = inputByLabel(/Slogan/i);
  ok('the inspector exposes a logo text field', !!tIn);
  ok('...and a slogan field', !!sIn);
  setText(tIn, 'VICTORY WORSHIP'); await sleep(60);
  setText(sIn, 'Come as you are'); await sleep(60);
  click(D.getElementById('btnTrans')); await sleep(350);

  const btn = () => logoBtns()[0];
  ok('after Take the row offers a real on/off button', !!btn() && !btn().disabled);
  // It ships visible:false, so adding one never surprises anyone on air.
  ok('a new logo starts OFF air', /off/i.test(btn().textContent));
  ok('...and is not on the Program monitor', !/VICTORY WORSHIP/.test(stageText('pg-scaler')));

  /* ---- the operator button puts it up, with no second TAKE ---- */
  const takeLabel = () => { const b = D.getElementById('btnTrans'); const s = b && b.querySelector('span'); return s ? s.textContent : ''; };
  click(btn()); await sleep(300);
  ok('clicking it puts the logo on air', /VICTORY WORSHIP/.test(stageText('pg-scaler')));
  ok('...the slogan too', /Come as you are/.test(stageText('pg-scaler')));
  ok('...the button says ON AIR', /ON AIR/i.test(btn().textContent));
  // Applied to Preview AND Program: Program-only would leave TAKE stuck reporting phantom
  // pending changes for the rest of the service.
  ok('...and TAKE does not go pending from it', /ON AIR/i.test(takeLabel()));

  /* ---- NOTHING ProPresenter does may take it down ---- */
  slideText = 'John 3:16\nFor God so loved the world.'; slideActive = true; presActive = true;
  layersObj = { slide: true, media: true }; await sleep(500);
  ok('a live verse does not disturb the logo', /VICTORY WORSHIP/.test(stageText('pg-scaler')));
  // F2 / Clear Slide
  slideText = ''; slideActive = false; presActive = false; layersObj = { slide: false, media: true };
  await sleep(700);
  ok('F2 (Clear Slide) leaves the logo up', /VICTORY WORSHIP/.test(stageText('pg-scaler')));
  // F1 / Clear All — every visual layer off. THIS is the one Brandon cares about.
  layersObj = { slide: false, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false };
  await sleep(700);
  ok('F1 (Clear All) leaves the logo up', /VICTORY WORSHIP/.test(stageText('pg-scaler')));
  ok('...and the verse really did clear (so the check above means something)',
     !/John 3:16/.test(stageText('pg-scaler')));

  /* ---- only the operator's own button takes it down ---- */
  click(btn()); await sleep(300);
  ok('the operator button clears the logo', !/VICTORY WORSHIP/.test(stageText('pg-scaler')));
  ok('...and says so', /off/i.test(btn().textContent));
  ok('...without leaving TAKE pending', /ON AIR/i.test(takeLabel()));
  click(btn()); await sleep(300);
  ok('it comes straight back on a second click', /VICTORY WORSHIP/.test(stageText('pg-scaler')));

  /* ---- media: a logo is usually a PNG or an MP4 with no text at all ---- */
  {
    click(rowByType('logo').querySelector('.nm')); await sleep(80);
    const t2 = inputByLabel(/Logo text/i), s2 = inputByLabel(/Slogan/i);
    setText(t2, ''); await sleep(60); setText(s2, ''); await sleep(60);
    click(D.getElementById('btnTrans')); await sleep(350);
    // An EMPTY persistent layer must not ride on air — no clear will ever take it off.
    // Measure the ELEMENT WRAPPER, not .s-title: showContent sets display:none on an empty
    // title regardless of whether the element itself is on air, so checking the text node
    // passes whether or not the guard exists. (Mutation-tested: the .s-title version
    // survived deleting the guard entirely.)
    const logoWrap = () => [...D.querySelectorAll('#pg-scaler .lt-el')].find(x => x.querySelector('.s-title'));
    ok('a logo with no text and no media leaves air', !logoWrap() || !painted(logoWrap(), W, D));
    const url = [...D.querySelectorAll('#panels input[type=text]')].find(i => /image or mp4/i.test(i.placeholder || ''));
    ok('the logo accepts an image / video', !!url);
    setText(url, 'https://example.com/church-logo.png'); await sleep(150);
    click(D.getElementById('btnTrans')); await sleep(350);
    const img = [...D.querySelectorAll('#pg-scaler .lt-media img')].find(i => /church-logo/.test(i.getAttribute('src') || ''));
    ok('an image-only logo renders on the Program monitor', !!img && painted(img, W, D));
    // ...and it is still immune to a Clear All with media as its only content.
    layersObj = { slide: false, media: false, props: false, messages: false, announcements: false, audio: false, video_input: false };
    slideText = ''; slideActive = false; presActive = false; await sleep(700);
    const img2 = [...D.querySelectorAll('#pg-scaler .lt-media img')].find(i => /church-logo/.test(i.getAttribute('src') || ''));
    ok('an image-only logo survives Clear All too', !!img2 && painted(img2, W, D));
  }

  /* ---- deleting it retires the row ---- */
  {
    const r = rowByType('logo');
    click(r.querySelector('.ic.danger') || [...r.querySelectorAll('.ic')].pop());
    await sleep(150);
    click(D.getElementById('btnTrans')); await sleep(350);
    ok('deleting the logo hides the operator row', !logoRowShown());
  }

  ok('none of it raised a console error', errors.length === 0);
  console.log('\nLOGO-LAYER RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 4)) : 'NONE'));
  try { W.close(); } catch (e) {}
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => {
  console.log('**FAIL**  THREW: ' + e.message);
  console.log('\nLOGO-LAYER RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW');
  process.exit(1);
});
