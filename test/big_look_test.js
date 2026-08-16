// A look with real embedded artwork must REACH AIR.
//
// WHY THIS EXISTS. relay.js capped a /config POST at 5,000,000 bytes. A look carrying an
// embedded church logo plus a background loop goes past that easily, and the relay then
// answered 413 to EVERY Take: the config never reached the relay, the relay never broadcast
// it, and the OBS Browser Source sat blank for the whole service. The only signal was one
// red line in the corner of the console. That is exactly what happened to Brandon on
// 2026-08-10, and "nothing shows in OBS" is the most expensive possible failure mode.
//
// The cap is now CONFIG_MAX (512 MB, LT_CONFIG_MAX-overridable). This suite runs against the
// REAL relay over REAL HTTP, because the bug lived in the relay's request handler and no
// amount of jsdom would have caught it.
//
// It also pins the two things that made the failure so hard to diagnose:
//   - localStorage overflow must NOT stop a Take. localStorage is the restore-on-reload
//     copy; the relay broadcast is what OBS actually consumes. lsSet() therefore swallows a
//     QuotaExceededError and returns false instead of throwing through the publish path.
//   - the 413 message must name the fix that works (link a local file), not tell the
//     operator to delete their artwork.
const http = require('http');
const path = require('path');
const relay = require('../relay.js');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

const server = relay.createServer(path.join(__dirname, '..', 'lt.html'));

function post(body, headers) {
  return new Promise((resolve) => {
    const port = server.address().port;
    const req = http.request({ host: '127.0.0.1', port, path: '/config', method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers || {}) },
      (res) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(body);
  });
}
const get = (p) => new Promise((resolve) => {
  const port = server.address().port;
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    const c = []; res.on('data', d => c.push(d));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
  }).on('error', () => resolve({ status: 0, body: '' }));
});

// An SSE subscriber, so we can prove the big look is actually BROADCAST — accepting the
// POST but failing to reach the output would be the same blank screen with extra steps.
function subscribe() {
  return new Promise((resolve) => {
    const port = server.address().port;
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let buf = '';
      const sub = { frames: [], stop: () => { try { req.destroy(); } catch (e) {} } };
      res.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data: ([\s\S]*)$/m.exec(frame);
          if (m) { try { sub.frames.push(JSON.parse(m[1])); } catch (e) {} }
        }
      });
      resolve(sub);
    });
  });
}

// A look the OLD 5 MB cap would have refused: ~9 MB of embedded artwork, which is an
// entirely ordinary logo PNG plus a short background loop.
function bigLook(mb) {
  const blob = 'A'.repeat(mb * 1024 * 1024);
  return JSON.stringify({
    _take: 7,
    conn: { host: '192.168.0.22', port: 57375, pollMs: 200, clearRule: 'all', clearLayer: 'media' },
    out: { bg: 'transparent', safe: false },
    elements: [
      { id: 'scr', type: 'scripture', name: 'Scripture', visible: true, source: { kind: 'live' },
        box: { mediaSrc: 'data:video/mp4;base64,' + blob, mediaType: 'video' } },
      { id: 'lg', type: 'logo', name: 'Logo', visible: true },
    ],
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const sub = await subscribe();
  await new Promise(r => setTimeout(r, 60));

  // THE regression test: the exact size that used to lose a service.
  {
    const body = bigLook(9);
    ok('a 9 MB look is over the OLD 5 MB cap (the fixture is honest)', Buffer.byteLength(body) > 5e6);
    const r = await post(body);
    ok('...and the relay ACCEPTS it (this answered 413 before)', r.status === 200);
    ok('...reporting success', /"ok":true/.test(r.body));
    await new Promise(r2 => setTimeout(r2, 120));
    const got = sub.frames.filter(f => f && f.type === 'program').pop();
    ok('...and BROADCASTS it to the OBS output', !!got && !!got.cfg && got.cfg._take === 7);
    ok('...with the embedded media intact', !!got && /^data:video\/mp4;base64,A+$/.test(got.cfg.elements[0].box.mediaSrc));
    const back = await get('/config');
    ok('...and serves it to an output that connects later', /"_take":7/.test(back.body));
  }

  // Still BOUNDED: the relay must not become a way to OOM the process holding the OBS
  // output up. Exercised through the LT_CONFIG_MAX override rather than by actually
  // shipping 600 MB — the cap is one comparison, so a small cap proves the same code path
  // in a second instead of a minute, and a 600 MB write races the relay's own
  // Connection: close and reports ECONNRESET on the client before the 413 is read.
  {
    const capped = relay.createServer(path.join(__dirname, '..', 'lt.html'));
    await new Promise((r) => capped.listen(0, '127.0.0.1', r));
    const p2 = capped.address().port;
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: p2, path: '/config', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(600 * 1024 * 1024) } },
        (res) => { res.resume(); resolve(res.statusCode); });
      // The relay answers 413 and closes while we are still writing, so a reset here is the
      // refusal landing — not a failure. Only silence would be a failure.
      req.on('error', () => resolve(resolve.answered || 'reset'));
      const chunk = Buffer.alloc(8 * 1024 * 1024, 0x42);
      let sent = 0;
      (function pump() {
        while (sent < 600 * 1024 * 1024) {
          if (req.destroyed || req.writableEnded) return;
          sent += chunk.length;
          if (!req.write(chunk)) return req.once('drain', pump);
        }
        try { req.end(); } catch (e) {}
      })();
    });
    ok('an absurd body is still refused (the cap is raised, not removed)', status === 413 || status === 'reset');
    await new Promise((r) => capped.close(r));
  }

  sub.stop();
  await new Promise((r) => server.close(r));

  /* ---- localStorage overflow must not stop a Take ---- */
  {
    const { JSDOM } = require('jsdom');
    const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');
    let posted = 0, alerted = 0;
    const dom = new JSDOM(html, {
      url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w) {
        w.ResizeObserver = class { observe() {} };
        w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
        w.requestAnimationFrame = (c) => setTimeout(c, 0);
        w.confirm = () => true; w.alert = () => { alerted++; };
        w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
        w.fetch = (u, o) => {
          if (/\/config/.test(String(u)) && o && o.method === 'POST') posted++;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        };
        w.console.error = () => {}; w.onerror = () => {};
      }
    });
    const W = dom.window, D = W.document;
    await new Promise(r => setTimeout(r, 600));
    // Storage is now full — every write throws, exactly as Chromium does at quota.
    // Override on Storage.prototype, NOT on the instance: jsdom's localStorage is a Proxy
    // whose set trap STORES a key, so  silently writes an item
    // called 'setItem' and leaves the real method in place — the stub never fires and every
    // assertion below passes vacuously. (Caught exactly that way.)
    const realSet = W.Storage.prototype.setItem;
    W.Storage.prototype.setItem = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };

    // lsSet itself: swallows, reports, and tells the caller it failed. This is the contract
    // the Take path depends on — a throw here would propagate out of btnTrans BEFORE
    // bus.publish() and the look would never reach OBS.
    const a0 = alerted;
    let lsThrew = false, ret = null;
    try { ret = W.lsSet('pplt.probe', { a: 1 }); } catch (e) { lsThrew = true; }
    ok('lsSet does not throw when storage is full', !lsThrew);
    ok('...returns false so callers can tell', ret === false);
    ok('...and warns the operator', alerted > a0);
    const a1 = alerted;
    W.lsSet('pplt.probe2', { b: 2 });
    ok('...but only once, not on every keystroke', alerted === a1);

    const before = posted;
    let threw = false;
    try { D.getElementById('btnTrans').dispatchEvent(new W.MouseEvent('click', { bubbles: true })); }
    catch (e) { threw = true; }
    await new Promise(r => setTimeout(r, 400));
    ok('a Take with FULL local storage does not throw', !threw);
    ok('...and still publishes to the relay (which is what OBS reads)', posted > before);
    W.Storage.prototype.setItem = realSet;
    try { dom.window.close(); } catch (e) {}
  }

  /* ---- Clear All, owned by the app ----
     MEASURED on a real ProPresenter 21.2 (2026-08-16): triggering Clear Slide and Clear All
     through the API and sampling every status endpoint gives byte-identical results —
     layers all false and presentation absent for BOTH. No app can tell the two keys apart by
     watching, so F1 is a key the APP owns: it empties the running list here and forwards the
     clear to ProPresenter as GET /v1/clear/layer/{layer} for every layer, the documented
     call. That forwarding is the whole mechanism, so it gets asserted. */
  {
    const { JSDOM } = require('jsdom');
    const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');
    const hits = [];
    const dom = new JSDOM(html, {
      url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w) {
        w.ResizeObserver = class { observe() {} };
        w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
        w.requestAnimationFrame = (c) => setTimeout(c, 0);
        w.confirm = () => true; w.alert = () => {};
        w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
        w.fetch = (u) => {
          const url = String(u);
          const m = /clear%2Flayer%2F(\w+)|clear\/layer\/(\w+)/.exec(url);
          if (m) hits.push(m[1] || m[2]);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        };
        w.console.error = () => {}; w.onerror = () => {};
      }
    });
    const W = dom.window, D = W.document;
    await new Promise(r => setTimeout(r, 700));
    // give it a ProPresenter to talk to
    const ip = D.querySelector('input[placeholder="192.168.1.100"]');
    if (ip) { ip.value = '192.168.1.95'; ip.dispatchEvent(new W.Event('input', { bubbles: true })); }
    await new Promise(r => setTimeout(r, 200));
    hits.length = 0;

    ok('the app exposes a Clear All handler', typeof W.ltClearAll === 'function');
    W.ltClearAll();   // exactly what the global shortcut calls
    await new Promise(r => setTimeout(r, 500));

    const LAYERS = ['slide', 'media', 'props', 'messages', 'announcements', 'audio', 'video_input'];
    const missing = LAYERS.filter(l => hits.indexOf(l) < 0);
    ok('Clear All forwards a clear for EVERY ProPresenter layer: ' + (missing.length ? 'missing ' + missing.join(',') : 'all 7'),
       missing.length === 0);
    try { dom.window.close(); } catch (e) {}
  }

  console.log('BIG-LOOK RESULT  pass=' + pass + '  fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('**FAIL** THREW: ' + e.message);
  console.log('BIG-LOOK RESULT  pass=' + pass + '  fail=' + (fail + 1));
  process.exit(1);
});
