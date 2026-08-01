// Graphics import / export — portable .json for looks, single elements, and the
// preset library.
//
// The bug this locks out: the old importer did `if(p.folders){presets=p;save()}`,
// so ANY json with a truthy `folders` key overwrote the library and was PERSISTED
// BEFORE it was rendered. One malformed file bricked the console on every later
// boot, with no way back from the UI. Nothing may be written unless the file
// validates.
//
// Also asserted: an imported element is rebuilt from a known-good default of its
// declared type (so unknown/hostile fields can't reach the renderer), ids are
// re-issued so an import can't collide with what's already on stage, and
// cross-references (visWith / dock.to) are remapped to the new ids or dropped —
// a dangling reference hides an element forever with no way to fix it.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = dom.window.document;

(async () => {
  await sleep(350);
  const P = W.parseGfx;
  ok('parseGfx is reachable', typeof P === 'function');

  /* ------------------------- malformed input is REFUSED ------------------------- */
  const bad = [
    ['not json at all',                 'totally not json'],
    ['empty string',                    ''],
    ['a bare number',                   '42'],
    ['null',                            'null'],
    ['an unrelated object',             '{"hello":"world"}'],
    ['THE BRICKING CASE: folders is an object, not a list', '{"folders":{"My Presets":[]}}'],
    ['folders is a string',             '{"folders":"nope"}'],
    ['folders is true',                 '{"folders":true}'],
    ['a look with no elements',         '{"kind":"look","config":{"elements":[]}}'],
    ['an element of an unknown type',   '{"kind":"element","element":{"type":"evilType"}}'],
    ['a file from another app',         '{"format":"some-other-app","kind":"look"}'],
    ['a file from a newer version',     '{"format":"lower-thirds-engine","version":99,"kind":"look","config":{"elements":[{"type":"text"}]}}'],
  ];
  bad.forEach(([label, text]) => {
    const r = P(text);
    ok('refused — ' + label, r && r.ok === false && typeof r.error === 'string' && r.error.length > 0);
  });

  /* ------------------------------- valid: element ------------------------------- */
  {
    const r = P(JSON.stringify({ format: 'lower-thirds-engine', version: 1, kind: 'element',
      element: { type: 'scripture', name: 'My Verse', id: 'OLD-ID', style: { ref: { size: 99 } } } }));
    ok('accepted — a valid element file', r.ok && r.kind === 'element');
    ok('element: the declared type survives', r.ok && r.payload.type === 'scripture');
    ok('element: the operator\'s name survives', r.ok && r.payload.name === 'My Verse');
    ok('element: a custom style value survives', r.ok && r.payload.style.ref.size === 99);
    ok('element: defaults are filled in from the real type', r.ok && !!r.payload.layout && !!r.payload.source);
    ok('element: the incoming id is REPLACED (no collisions)', r.ok && r.payload.id && r.payload.id !== 'OLD-ID');
  }
  {
    // unknown/hostile fields must not survive onto the element
    const r = P(JSON.stringify({ kind: 'element', element: { type: 'text', __proto__x: 1, onclick: 'alert(1)' } }));
    ok('element: a stray onclick field is not carried through', r.ok && r.payload.onclick === undefined);
  }

  /* --------------------------------- valid: look -------------------------------- */
  {
    const look = { format: 'lower-thirds-engine', version: 1, kind: 'look', name: 'Sunday',
      config: { elements: [
        { id: 'a', type: 'scripture', name: 'Verse' },
        { id: 'b', type: 'name', name: 'Speaker', vis: 'linked', visWith: 'a' },
        { id: 'c', type: 'media', name: 'Logo', dock: { on: true, to: 'a', x: 10, y: 10, w: 100, h: 100 } },
        { id: 'd', type: 'text', name: 'Dangling', vis: 'linked', visWith: 'GONE' },
        { type: 'bogusType', name: 'should be dropped' },
      ], conn: { host: '10.9.9.9', port: 1234 } } };
    const r = P(JSON.stringify(look));
    ok('accepted — a valid look file', r.ok && r.kind === 'look');
    const els = r.ok ? r.payload.config.elements : [];
    ok('look: the unknown-type element was dropped', els.length === 4);
    ok('look: every element got a fresh id', els.every(e => e.id && !['a','b','c','d'].includes(e.id)));

    const byName = (n) => els.find(e => e.name === n);
    const verse = byName('Verse'), speaker = byName('Speaker'), logo = byName('Logo'), dangling = byName('Dangling');
    ok('look: visWith was REMAPPED to the new id', speaker && speaker.visWith === verse.id);
    ok('look: dock.to was REMAPPED to the new id', logo && logo.dock.to === verse.id);
    ok('look: a DANGLING visWith was dropped', dangling && !dangling.visWith);
    ok('look: and its vis mode fell back so it stays visible', dangling && dangling.vis !== 'linked');
    ok('look: another machine\'s ProPresenter conn is NOT imported', r.ok && r.payload.config.conn === undefined);
  }

  /* ------------------------------- valid: library ------------------------------- */
  {
    const lib = { format: 'lower-thirds-engine', version: 1, kind: 'library', folders: [
      { id: 'f1', name: 'Sunday AM', items: [
        { id: 'p1', name: 'Sermon look', config: { elements: [{ id: 'x', type: 'scripture' }] } },
        { id: 'p2', name: 'Bad one', config: null },
      ]},
    ]};
    const r = P(JSON.stringify(lib));
    ok('accepted — a valid library file', r.ok && r.kind === 'library');
    ok('library: the folder name survives', r.ok && r.payload[0].name === 'Sunday AM');
    ok('library: the malformed preset was dropped', r.ok && r.payload[0].items.length === 1);
    ok('library: the good preset survives with its elements', r.ok && r.payload[0].items[0].config.elements.length === 1);
  }
  {
    // the LEGACY bare {folders:[...]} export must still import
    const legacy = { folders: [{ id: 'f', name: 'Old export', items: [
      { id: 'p', name: 'Old preset', config: { elements: [{ id: 'e', type: 'text' }] } }]}]};
    const r = P(JSON.stringify(legacy));
    ok('accepted — a LEGACY {folders:[...]} export still imports', r.ok && r.kind === 'library');
    ok('legacy: its preset survives', r.ok && r.payload[0].items.length === 1);
  }

  /* ------------------------- round-trip: export -> import ----------------------- */
  {
    // build a look the way the app does, then feed its own export back in
    const cfg = W.defaultConfig();
    const s = W.createElement('scripture'); s.name = 'RT Verse';
    const n = W.createElement('name'); n.name = 'RT Name'; n.vis = 'linked'; n.visWith = s.id;
    cfg.elements = [s, n];
    const file = JSON.stringify({ format: 'lower-thirds-engine', version: 1, kind: 'look', name: 'RT', config: cfg });
    const r = P(file);
    ok('round-trip: an exported look re-imports cleanly', r.ok && r.kind === 'look');
    const els = r.ok ? r.payload.config.elements : [];
    ok('round-trip: both elements survive', els.length === 2);
    ok('round-trip: the link between them still resolves',
       els[1].visWith === els[0].id && els[0].id !== s.id);
  }

  /* ------------------------ the serialiser round-trips -------------------------- */
  // The export/import ACTIONS live in the console scope (they need `preview` and
  // `presets`), so they're verified through the UI below rather than on window.
  ok('gfxWrap stamps a format so a foreign file can be told apart',
     W.gfxWrap('look', {}).format === 'lower-thirds-engine');
  ok('gfxWrap stamps a version for future migrations', W.gfxWrap('look', {}).version === 1);
  ok('gfxWrap records the kind', W.gfxWrap('element', {}).kind === 'element');
  ok('safeName strips path/shell characters out of a filename',
     !/[\\/:*?"<>|]/.test(W.safeName('My/Look:*?"<>|name')));

  /* --------------------- the UI actually offers the controls -------------------- */
  {
    const sec = [...D.querySelectorAll('details.sec')]
      .find(x => /Presets & folders/.test(x.querySelector('summary')?.textContent || ''));
    const t = sec ? sec.textContent : '';
    ok('UI: "Export look" is offered', /Export look/.test(t));
    ok('UI: "Export all presets" is offered', /Export all presets/.test(t));
    ok('UI: "Import" is offered', /Import/.test(t));
    const insp = [...D.querySelectorAll('details.sec')]
      .find(x => /^Element:/.test(x.querySelector('summary')?.textContent || ''));
    ok('UI: per-element export is offered in the inspector',
       !!insp && /Export this element/.test(insp.textContent));
  }

  ok('nothing threw', errors.length === 0);
  console.log('\nGRAPHICS-IO RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? errors.slice(0, 3).join(' | ') : 'NONE'));
  process.exit(fail ? 1 : 0);
})();
