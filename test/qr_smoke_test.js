// Fast structural smoke test for the QR encoder — the deep coverage (Reed-Solomon,
// published format strings, independent decode) lives in qr_test.js. This one just
// proves the encoder is reachable and lays out a scannable symbol.
//
// WHY THIS IS A FILE AND NOT AN INLINE `node -e` PROBE: loading lt.html with
// runScripts:'dangerously' starts the app's setInterval timers, and JSDOM keeps them
// on Node's event loop forever. A probe with no window.close()/process.exit() NEVER
// EXITS — one ran for 44 hours before it was noticed. Every suite in test/ ends with
// an explicit process.exit() for exactly this reason. Keep it that way.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() {} close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0);
    w.alert = () => {}; w.confirm = () => true;
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    w.console.error = () => {}; w.onerror = () => {};
  }
});

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

setTimeout(() => {
  try {
    const W = dom.window;
    ok('qrEncode is exposed', typeof W.qrEncode === 'function');

    const q = W.qrEncode('HELLO WORLD');
    ok('encodes a short string (v' + (q && q.version) + ', ' + (q && q.size) + 'x' + (q && q.size) + ')',
       !!q && q.version === 1 && q.size === 21);

    const m = q.modules, s = q.size;
    const finderOK = (R, C) => m[R][C] && m[R][C + 6] && m[R + 6][C] && m[R + 6][C + 6] &&
                               !m[R + 1][C + 1] && m[R + 2][C + 2];
    ok('finder patterns TL/TR/BL', finderOK(0, 0) && finderOK(0, s - 7) && finderOK(s - 7, 0));

    let timing = true;
    for (let i = 8; i < s - 8; i++) {
      if (m[6][i] !== (i % 2 === 0)) timing = false;
      if (m[i][6] !== (i % 2 === 0)) timing = false;
    }
    ok('timing patterns alternate on row/col 6', timing);

    // ISO/IEC 18004: the module at (4*version+9, 8) is ALWAYS dark. It was being
    // overwritten by a mis-walked format-info copy — this assertion caught that.
    ok('dark module at (' + (s - 8) + ',8) is set', m[s - 8][8] === true);

    const svg = W.qrSvg('https://example.com/give');
    ok('qrSvg returns an svg', typeof svg === 'string' && svg.startsWith('<svg') && svg.length > 500);

    ok('scales version with payload size', W.qrEncode('x'.repeat(120)).version >= 6);
    ok('returns null past capacity instead of truncating', W.qrEncode('x'.repeat(400)) === null);
  } catch (e) {
    console.log('**FAIL**  THREW: ' + e.message);
    fail++;
  }

  console.log('\nQR-SMOKE RESULT  pass=' + pass + '  fail=' + fail);
  // Tear the window down and exit explicitly — see the note at the top of this file.
  try { dom.window.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}, 400);
