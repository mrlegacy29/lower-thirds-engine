// Console controls that were WIRED BUT INERT — they responded, so nothing threw and
// nothing looked broken in a test, but they did not do the thing they claimed.
//
// This needs a FRESH boot with no ProPresenter host and no Name element, which is exactly
// the state an operator opens the app in. operator_test cannot host these: by the time it
// gets here it has already added a live Name element and configured a host, so both
// assertions would be judged against the wrong state.
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
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    w.console.error = (...a) => errors.push(a.join(' '));
    w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = W.document;
const click = (n) => n && n.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));

(async () => {
  await sleep(700);

  /* ---- "Live ProPresenter feed" with no host ----
     It latched ON, relabelled itself "…: ON", and then received nothing forever. Worst in
     the operator skins, which have no host field to fix it with. */
  {
    const live = D.getElementById('simLive');
    ok('the live-feed toggle exists', !!live);
    const before = live.textContent;
    click(live); await sleep(80);
    ok('live-feed refuses to latch with no ProPresenter IP', !live.classList.contains('on'));
    ok('...and says what to do about it', /ProPresenter IP/i.test(live.textContent));
    await sleep(1500);
    ok('...and puts its own label back', live.textContent === before);
  }

  /* ---- flash() stickiness ----
     It captured textContent on EVERY call, so a second click while a flash was showing
     captured the FLASH TEXT as the "original" — the button then kept that label for the
     rest of the session. "Sample name" got stuck reading "Add a Name element". */
  {
    const sn = D.getElementById('simName');
    ok('the sample-name button exists', !!sn);
    const orig = sn.textContent;
    click(sn); await sleep(80);
    ok('a flash message is showing', sn.textContent !== orig);
    click(sn); await sleep(80);                 // second click WHILE the flash is up
    await sleep(1700);
    ok('the label restores after repeated flashes (not stuck on the flash text)',
       sn.textContent === orig);
  }

  /* ---- "Connect / reconnect" with an empty IP ----
     It tore down any working feed and had nothing to reconnect to, while the status line
     kept whatever it last said. */
  {
    const btn = [...D.querySelectorAll('button')].find(b => /Connect \/ reconnect/i.test(b.textContent));
    ok('the connect button exists', !!btn);
    if (btn) {
      const before = btn.textContent;
      click(btn); await sleep(80);
      ok('connect refuses with an empty IP and says so', /IP/i.test(btn.textContent) && btn.textContent !== before);
      await sleep(1500);
      ok('...and restores its label', btn.textContent === before);
    }
  }

  ok('no console errors from any of it', errors.length === 0);
  console.log('\nCONSOLE-CONTROLS RESULT  pass=' + pass + '  fail=' + fail);
  try { dom.window.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('**FAIL**  THREW: ' + e.message);
  console.log('\nCONSOLE-CONTROLS RESULT  pass=' + pass + '  fail=' + (fail + 1));
  process.exit(1);
});
