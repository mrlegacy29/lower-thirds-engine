// A TAKE that the relay REFUSES must never look like a success.
//
// This shipped: publish() computed three specific failure strings ("too large", "not
// reachable", "answered N"), but the only onStatus subscriber had signature (ok) and threw
// the message away, and it wrote solely to #relayPill/#relayTxt/#relDot — which live in
// .side/.topbar and are display:none under #console-root.op. So in Showcaller and Simple,
// the skins a service is actually run from, a refused TAKE produced NO signal at all while
// #btnTrans still flashed green and the caption still read "you are live". OBS meanwhile
// kept showing the previous look.
//
// The 413 path itself is now nearly unreachable in practice — relay.js's CONFIG_MAX was
// raised from 5 MB to 512 MB on 2026-08-10 after a real service was lost to it: a look
// carrying an embedded logo + background loop failed EVERY Take, so the OBS output sat
// blank all morning with only a red line in the corner of the console to say why. The
// reporting path still has to work, because a 413 is still what the relay answers if
// someone ever does exceed it — so this suite forces the response rather than the size.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Boots a console, lets the seed publish succeed, then fails (or passes) the operator's TAKE.
function boot(skin, takeStatus) {
  let posts = 0;
  const dom = new JSDOM(html, {
    url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} };
      w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
      w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
      w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
      w.fetch = (u, o) => {
        const url = String(u);
        if (/\/config/.test(url) && o && o.method === 'POST') {
          posts++;
          // the boot seed publish always succeeds — the relay is healthy until this one TAKE
          if (posts === 1 || takeStatus === 200)
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
          return Promise.resolve({ ok: false, status: takeStatus, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      };
      w.console.error = () => {}; w.onerror = () => {};
    }
  });
  return dom;
}

// "on screen" means painted: walk the ancestor chain for display/visibility. textContent
// alone counts hidden nodes, and rect sizes are 0x0 in jsdom — both give false answers.
const visibleText = (D, W) => [...D.querySelectorAll('#console-root *')]
  .filter(n => {
    if (n.children.length) return false;
    if (!(n.textContent || '').trim()) return false;
    let a = n;
    while (a && a !== D.body) {
      const cs = W.getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      a = a.parentElement;
    }
    return true;
  })
  .map(n => n.textContent.trim());

async function run(skin, status) {
  const dom = boot(skin, status);
  const W = dom.window, D = W.document;
  const click = (n) => n && n.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await sleep(650);
  if (skin !== 'builder') {
    const vs = D.getElementById('viewSwitch');
    const b = vs && [...vs.querySelectorAll('button')].find(x => x.dataset.view === skin);
    click(b); await sleep(200);
  }
  await sleep(250);
  click(D.getElementById('btnTrans'));
  await sleep(600);
  const btn = D.getElementById('btnTrans');
  const vis = visibleText(D, W);
  const res = {
    cls: btn ? btn.className : '',
    failTextOnScreen: vis.some(t => /fail|too large|not reach|not respond|previous look/i.test(t)),
    // the SPECIFIC diagnosis, not just "something went wrong" — this is what tells the
    // operator the look is too big to send, which is the actual fix they need
    specificOnScreen: vis.some(t => /too large for the local server/i.test(t) && /local file/i.test(t)),
  };
  try { dom.window.close(); } catch (e) {}
  return res;
}

(async () => {
  for (const skin of ['builder', 'showcaller', 'simple']) {
    const bad = await run(skin, 413);
    ok(skin + ': a refused TAKE does NOT flash success', !/flashok/.test(bad.cls));
    ok(skin + ': a refused TAKE flashes failure', /flashfail/.test(bad.cls));
    ok(skin + ': the failure is actually ON SCREEN', bad.failTextOnScreen);
    ok(skin + ': and says WHY, naming the fix that works (link the file)', bad.specificOnScreen);

    const good = await run(skin, 200);
    ok(skin + ': an accepted TAKE still flashes success', /flashok/.test(good.cls));
    ok(skin + ': an accepted TAKE shows no failure text', !good.failTextOnScreen);
  }
  console.log('\nTAKE-STATUS RESULT  pass=' + pass + '  fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('**FAIL**  THREW: ' + e.message);
  console.log('\nTAKE-STATUS RESULT  pass=' + pass + '  fail=' + (fail + 1));
  process.exit(1);
});
