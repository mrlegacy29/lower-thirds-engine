// The CONSOLE half of routing by ProPresenter slide label / group.
//
// The engine side (ppMatches / deckLib / the on-air gate) is covered by pp_resilience_test
// and output_test. What is only testable here is the part the operator actually touches:
// the dropdown in the Layers list has to fill itself from whatever presentation is open in
// ProPresenter — Brandon's requirement was "if i create it in pp7 i dont have to create it
// in the program as well" — and the Program monitor has to obey the binding while the
// BUILDER preview deliberately does not (or a bound element could never be positioned).
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');
const { painted } = require('./_onair');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A real PP 21.2 shape: ONE group holding four labelled slides plus one unlabelled.
// slide_index is FLAT across the deck — that is the only join, since slides carry no uuid.
const DECK = [{ name: 'John 1:1-3', slides: [
  { label: 'Top Lower 3rds' }, { label: 'Bot Lower 3rds' },
  { label: 'Left Lower 3rds' }, { label: 'Right Lower 3rds' }, { label: '' } ] }];

// The stored look this test seeds has to be a COMPLETE element — the panels read
// d.style.*/d.box.* directly, and a hand-rolled stub throws during the first render (which
// then looks like a failure of the feature under test). Build it with the app's OWN factory
// in a throwaway boot rather than guessing the shape.
function makeSeedElement() {
  const probe = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'dangerously',
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} };
      w.EventSource = class { close() {} };
      w.requestAnimationFrame = (c) => setTimeout(c, 0);
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      w.console.error = () => {};
    } });
  const e = probe.window.createElement('text');
  e.id = 'ghost'; e.name = 'Ghost'; e.content = { text: 'GHOST' };
  e.source = { kind: 'manual' }; e.ppMatch = 'L:Imported Label';
  e.layout = { x: 10, y: 10, w: 400, h: 100 };
  e.anim = Object.assign({}, e.anim, { durIn: 0, durOut: 0 });
  const json = JSON.stringify({ elements: [e] });
  try { probe.window.close(); } catch (x) {}
  return json;
}
const SEED = makeSeedElement();

const errors = [];
let slideText = 'John 1:1\nIn the beginning was the Word.', slideActive = true;
let slideIdx = 0, deckGroups = DECK, deckUuid = 'deck-1', presActive = true;
// A SECOND deck — the one ProPresenter merely has open in its editor. Its labels have to
// reach the dropdown without it ever being presented; otherwise configuring a look for next
// Sunday's sermon means putting that deck on screen in front of the congregation.
// Deliberately does NOT contain the word "focused": these fake arms match on bare substrings
// (the relay URL-encodes the path into a ?target= query, so a slash-bearing regex can never
// match), and a uuid containing "focused" was swallowed by the pointer arm below — the deck
// fetch came back as a bare {uuid,name} with no groups and the feature looked broken.
const FOCUS_UUID = 'deck-2-open';
let focusedUuid = null, focusedGroups = [{ name: 'Sermon Points', slides: [
  { label: 'Point One' }, { label: 'Point Two' } ] }];

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    // Seed a stored look carrying a binding whose label this machine has NEVER seen — an
    // import from another PC, or a look saved before the deck was opened here. The select
    // must still report what it is bound to instead of falling back to "Any slide", which
    // would tell the operator an element is ungated when it is in fact off air.
    try { w.localStorage.setItem('pplt.preview.v2', SEED); } catch (e) {}
    w.fetch = (u) => {
      const url = String(u);
      if (/active/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({
        presentation: presActive ? { id: { uuid: deckUuid, name: 'John 1_1-3', index: 0 }, groups: deckGroups || undefined } : null }) });
      if (/layers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ slide: slideActive, media: true }) });
      // "slide_index" contains "slide" — it has to be matched FIRST or the generic slide
      // arm answers it with a text payload and the index never resolves.
      if (/slide_index/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ presentation_index: { index: slideIdx } }) });
      if (/slide/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      // The deck ProPresenter has OPEN. /focused is a tiny pointer; the deck itself comes
      // from /v1/presentation/<uuid>. Matched on the bare words because the app addresses
      // ProPresenter through the relay, which URL-ENCODES the path into a ?target= query —
      // a regex containing a slash would never match here.
      // uuid arm FIRST — a real ProPresenter uuid is a hex GUID, but keeping the specific
      // match ahead of the generic one is what stops a fixture rename from silently
      // re-breaking this.
      if (url.indexOf(FOCUS_UUID) >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve(
        { presentation: { id: { uuid: FOCUS_UUID, name: 'Next Sunday' }, groups: focusedGroups } }) });
      if (/focused/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve(
        focusedUuid ? { uuid: focusedUuid, name: 'Next Sunday', index: 1 } : {}) });
      // The GLOBAL group library. Present on PP 21.2; older builds 404 and the dropdown
      // then falls back to the groups found in the live deck.
      if (/groups/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve(
        [{ id: { uuid: 'g1', name: 'Verse', index: 0 } }, { id: { uuid: 'g2', name: 'Chorus', index: 1 } }]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' '));
    w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const click = (n) => { if (!n) throw new Error('control not found'); n.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
const rows = () => [...D.querySelectorAll('.elrow')];
const rowFor = (name) => rows().find(r => r.querySelector('.nm') && new RegExp(name).test(r.querySelector('.nm').textContent));
const bindOf = (name) => { const r = rowFor(name); return r && r.querySelector('select.ppbind'); };
const optVals = (s) => [...s.querySelectorAll('option')].map(o => o.value);
const pgText = () => { const root = D.getElementById('pg-scaler'); if (!root) return '';
  const out = []; const wk = D.createTreeWalker(root, W.NodeFilter.SHOW_TEXT, null); let n;
  while ((n = wk.nextNode())) { const t = (n.nodeValue || '').trim(); if (t && painted(n.parentElement, W, D)) out.push(t); }
  return out.join(' '); };
const pvText = () => { const root = D.getElementById('pv-scaler'); if (!root) return '';
  const out = []; const wk = D.createTreeWalker(root, W.NodeFilter.SHOW_TEXT, null); let n;
  while ((n = wk.nextNode())) { const t = (n.nodeValue || '').trim(); if (t && painted(n.parentElement, W, D)) out.push(t); }
  return out.join(' '); };

(async () => {
  await sleep(600);

  /* ---- the control exists, per element, before anything is connected ---- */
  ok('every layer row carries a binding dropdown',
     rows().length > 0 && rows().every(r => !!r.querySelector('select.ppbind')));
  {
    const g = bindOf('Ghost');
    ok('a stored binding survives the boot', !!g && g.value === 'L:Imported Label');
    ok('...and is NOT misreported as "Any slide"', !!g && g.value !== '');
    ok('...and is labelled as unknown to this deck',
       !!g && /not in the current deck/i.test(g.innerHTML));
  }

  /* ---- connect: the dropdown fills itself from ProPresenter ---- */
  const ip = D.querySelector('input[placeholder="192.168.1.100"]');
  ok('the ProPresenter IP field is there', !!ip);
  ip.value = '127.0.0.1'; ip.dispatchEvent(new W.Event('input', { bubbles: true }));
  click([...D.querySelectorAll('button')].find(b => /Connect \/ reconnect/i.test(b.textContent)));
  await sleep(900);

  {
    const g = bindOf('Ghost');
    const vals = optVals(g);
    ok('the live deck\'s labels appear with no typing',
       ['Top Lower 3rds', 'Bot Lower 3rds', 'Left Lower 3rds', 'Right Lower 3rds']
         .every(l => vals.indexOf('L:' + l) >= 0));
    ok('the unlabelled slide contributes no blank entry',
       vals.filter(v => v === 'L:').length === 0);
    ok('the deck\'s own group is offered too', vals.indexOf('G:John 1:1-3') >= 0);
    ok('...as is ProPresenter\'s global group library (/v1/groups)',
       vals.indexOf('G:Verse') >= 0 && vals.indexOf('G:Chorus') >= 0);
    ok('"Any slide" is still the first option', vals[0] === '');
    ok('the imported binding is STILL selected after the refill', g.value === 'L:Imported Label');
    // Persisted, so the labels are there next launch before ProPresenter is even reachable.
    let saved = null; try { saved = JSON.parse(W.localStorage.getItem('pplt.pplib.v1')); } catch (e) {}
    ok('the library is persisted for the next launch',
       !!saved && saved.labels.indexOf('Top Lower 3rds') >= 0);
  }

  /* ---- picking a label actually binds the element, and the row says so ----
     The Program monitor mirrors what OBS is showing, so a binding only reaches it after a
     TAKE — same as every other edit in this app. */
  const take = async () => { click(D.getElementById('btnTrans')); await sleep(350); };
  {
    const g = bindOf('Ghost');
    g.value = 'L:Top Lower 3rds'; g.dispatchEvent(new W.Event('change', { bubbles: true }));
    await sleep(300);
    ok('picking a label writes it to the element',
       bindOf('Ghost') && bindOf('Ghost').value === 'L:Top Lower 3rds');
    // slideIdx 0 IS "Top Lower 3rds", so this binding is live right now.
    ok('the row marks a binding the live slide matches',
       rowFor('Ghost').classList.contains('ppon'));

    /* ---- the Program monitor obeys it; the builder preview deliberately does not ---- */
    await take();
    ok('bound element is on the Program monitor while its label is live', /GHOST/.test(pgText()));
    slideIdx = 1; slideText = 'John 1:2\nThe same was in the beginning with God.';
    await sleep(600);
    ok('...and leaves the Program monitor when the label changes', !/GHOST/.test(pgText()));
    ok('...while the BUILDER preview keeps showing it so it can still be positioned',
       /GHOST/.test(pvText()));
    ok('the row now marks the binding as not matching',
       rowFor('Ghost').classList.contains('ppoff') && !rowFor('Ghost').classList.contains('ppon'));

    // Back to the matching slide — the element returns with no operator action at all.
    slideIdx = 0; slideText = 'John 1:1\nIn the beginning was the Word.';
    await sleep(600);
    ok('returning to the labelled slide brings it back on air', /GHOST/.test(pgText()));
  }

  /* ---- a label added in ProPresenter mid-session must show up ----
     The poller caches the deck by uuid. Keying ONLY on uuid meant a label added while the
     same presentation stayed open was invisible until the operator switched decks or
     reconnected — which is exactly when someone is setting these labels up. */
  {
    deckGroups = [{ name: 'John 1:1-3', slides: DECK[0].slides.concat([{ label: 'Centre Lower 3rds' }]) }];
    await sleep(700);
    ok('a label added in ProPresenter appears without reconnecting',
       optVals(bindOf('Ghost')).indexOf('L:Centre Lower 3rds') >= 0);
  }

  /* ---- a deck ProPresenter merely has OPEN also fills the dropdown ----
     Verified against PP 21.2: /v1/presentation/focused returns the selected deck whether or
     not it is being presented. Without this you had to put a deck on screen to configure a
     look for it. */
  {
    const before = optVals(bindOf('Ghost'));
    ok('an un-presented deck contributes nothing until it is focused',
       before.indexOf('L:Point One') < 0);
    focusedUuid = FOCUS_UUID;
    await sleep(3000);                       // the focused poll runs ~every 10 ticks
    const after = optVals(bindOf('Ghost'));
    ok('selecting a deck in ProPresenter surfaces its labels — no need to present it',
       after.indexOf('L:Point One') >= 0 && after.indexOf('L:Point Two') >= 0);
    ok('...and its group as well', after.indexOf('G:Sermon Points') >= 0);
    ok('the LIVE deck\'s labels are still there', after.indexOf('L:Top Lower 3rds') >= 0);

    // Editing a label while that deck stays selected must land too — the uuid does not change.
    focusedGroups = [{ name: 'Sermon Points', slides: [
      { label: 'Point One' }, { label: 'Point Two' }, { label: 'Point Three' } ] }];
    await sleep(3000);
    ok('a label edited in the focused deck appears without reselecting',
       optVals(bindOf('Ghost')).indexOf('L:Point Three') >= 0);
  }

  /* ---- "Type a label…" ----
     ProPresenter publishes its Groups library but has NO endpoint for Settings -> Slide
     Labels, so a label that sits on no slide of any deck seen here is otherwise
     unreachable. Must use askText: window.prompt is a no-op in Electron. */
  {
    const g = bindOf('Ghost');
    ok('the dropdown offers a way in for a label the API cannot publish',
       optVals(g).some(v => /typeLabel/.test(v)));
    g.value = optVals(g).find(v => /typeLabel/.test(v));
    g.dispatchEvent(new W.Event('change', { bubbles: true }));
    await sleep(120);
    const dlg = D.querySelector('.lt-ask');
    ok('a text dialog opens (not a dead window.prompt)', !!dlg);
    const inp = dlg.querySelector('input[type=text]');
    inp.value = '  spoken WORD  ';            // deliberately messy
    inp.dispatchEvent(new W.Event('input', { bubbles: true }));
    click(dlg.querySelector('[data-ask="ok"]'));
    await sleep(300);
    ok('the typed label becomes the binding', bindOf('Ghost').value === 'L:spoken WORD');
    // Read the PERSISTED library, not this element's own dropdown: paint() re-adds an
    // unknown current binding under "Not in the current deck", so checking the dropdown
    // passes whether or not the merge happened. (Mutation-tested — the dropdown version
    // survived deleting the merge entirely.)
    let lib2 = null; try { lib2 = JSON.parse(W.localStorage.getItem('pplt.pplib.v1')); } catch (e) {}
    ok('...and joins the library, so every other element is offered it',
       !!lib2 && lib2.labels.indexOf('spoken WORD') >= 0);
    // Matching is case-insensitive, so a hand-typed label behaves like a polled one.
    ok('a typed label matches the real slide regardless of case',
       W.ppMatches('L:spoken WORD', { label: 'Spoken Word' }) === true);

    // Cancelling must not strand the sentinel as the element's binding.
    const g2 = bindOf('Ghost');
    g2.value = optVals(g2).find(v => /typeGroup/.test(v));
    g2.dispatchEvent(new W.Event('change', { bubbles: true }));
    await sleep(120);
    click(D.querySelector('.lt-ask [data-ask="cancel"]'));
    await sleep(300);
    ok('cancelling leaves the previous binding intact', bindOf('Ghost').value === 'L:spoken WORD');

    // An all-whitespace entry is the same as cancelling — it must not bind the element to
    // an empty label, which ppMatches would treat as "any slide" and quietly un-gate it.
    const g3 = bindOf('Ghost');
    g3.value = optVals(g3).find(v => /typeLabel/.test(v));
    g3.dispatchEvent(new W.Event('change', { bubbles: true }));
    await sleep(120);
    const dlg3 = D.querySelector('.lt-ask');
    dlg3.querySelector('input[type=text]').value = '     ';
    click(dlg3.querySelector('[data-ask="ok"]'));
    await sleep(300);
    ok('a blank entry changes nothing', bindOf('Ghost').value === 'L:spoken WORD');
    ok('...and adds no empty label to the library', (() => {
      let l = null; try { l = JSON.parse(W.localStorage.getItem('pplt.pplib.v1')); } catch (e) {}
      return !!l && l.labels.every(x => x.trim() !== '');
    })());
  }

  /* ---- unbinding releases the element ---- */
  {
    // park on a slide the binding does NOT match, so "released" is the only reason it
    // could come back — otherwise this passes for the wrong reason.
    slideIdx = 1; slideText = 'John 1:2\nThe same was in the beginning with God.';
    await sleep(600);
    const g = bindOf('Ghost');
    g.value = ''; g.dispatchEvent(new W.Event('change', { bubbles: true }));
    await sleep(200); await take();
    ok('clearing the binding puts the element back on the Program monitor', /GHOST/.test(pgText()));
    ok('...and drops the row marker',
       !rowFor('Ghost').classList.contains('ppon') && !rowFor('Ghost').classList.contains('ppoff'));
  }

  ok('none of it raised a console error', errors.length === 0);
  console.log('\nPP-LABEL-UI RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 4)) : 'NONE'));
  try { dom.window.close(); } catch (e) {}
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => {
  console.log('**FAIL**  THREW: ' + e.message);
  console.log('\nPP-LABEL-UI RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW');
  process.exit(1);
});
