// A corrupt saved preset library must never stop the console from booting.
//
// loadPresets() wrapped JSON.parse in try/catch, which only survives INVALID JSON. Valid
// JSON of the WRONG SHAPE ({"folders":"oops"}, null, [], 42) sailed through and then threw
// on the first presets.folders.forEach() inside secPresets() during renderPanels() — at
// BOOT. Result: both monitors blank, ProPresenter never connects, no UI left to recover
// with, and it repeats on every launch because the bad value is still in localStorage.
//
// Each case needs its own JSDOM because the failure happens during initial script
// evaluation, so the value has to be seeded before the app runs.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

function bootWith(badValue) {
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      try { w.localStorage.setItem('pplt.presets.v2', badValue); } catch (e) {}
      w.ResizeObserver = class { observe() {} };
      w.EventSource = class { constructor() {} close() {} };
      w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
      w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      w.console.error = (...a) => errors.push(a.join(' '));
      w.onerror = (m) => errors.push(String(m));
    }
  });
  return { dom, errors };
}

const CASES = [
  ['null', 'null'],
  ['an array', '[]'],
  ['a number', '42'],
  ['a bare string', '"a string"'],
  ['folders as a string', '{"folders":"oops"}'],
  ['folders holding junk', '{"folders":[null,3,{"name":"ok","items":[null]}]}'],
  ['an unrelated object', '{"nope":1}'],
  ['truncated JSON', '{not json'],
  ['empty string', ''],
];

(async () => {
  for (const [label, bad] of CASES) {
    const { dom, errors } = bootWith(bad);
    await new Promise(r => setTimeout(r, 700));
    const D = dom.window.document;
    // "booted" = the console actually rendered its preview stage with elements on it.
    // Checking only for the absence of a throw would pass on a blank, useless console.
    const booted = !!D.getElementById('pv-scaler') &&
                   D.querySelectorAll('#pv-scaler .lt-el').length > 0;
    ok('boots with a preset library that is ' + label, booted);
    ok('...and raises no error doing it (' + label + ')', errors.length === 0);
    try { dom.window.close(); } catch (e) {}
  }

  // and a WELL-FORMED library must still survive intact — the guard must not eat real data
  {
    const good = JSON.stringify({ folders: [{ id: 'f1', name: 'Sunday', items: [{ id: 'p1', name: 'Sermon look', config: {} }] }] });
    const { dom, errors } = bootWith(good);
    await new Promise(r => setTimeout(r, 700));
    const D = dom.window.document;
    const txt = D.body.textContent || '';
    ok('a valid preset library still loads', /Sunday/.test(txt) && errors.length === 0);
    ok('...and keeps its saved look', /Sermon look/.test(txt));
    try { dom.window.close(); } catch (e) {}
  }

  console.log('\nPRESET-RESILIENCE RESULT  pass=' + pass + '  fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('**FAIL**  THREW: ' + e.message);
  console.log('\nPRESET-RESILIENCE RESULT  pass=' + pass + '  fail=' + (fail + 1));
  process.exit(1);
});
