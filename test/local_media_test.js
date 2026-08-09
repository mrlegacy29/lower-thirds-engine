// OBS-style LOCAL FILE media: /media on the relay + the "…or a local file on this PC"
// field in the Background image / video panel.
//
// WHY THE MECHANISM IS A RELAY ENDPOINT AND NOT A file:// SRC: the output page is served
// over http, and an http page may not load file:// subresources — Chromium refuses, in OBS's
// browser source exactly as in a normal tab. So the relay serves the file at
// /media?src=<path> and the config stores that RELATIVE url, which resolves against the
// relay's own origin on the console, the OBS output and the SDI offscreen window alike.
//
// Part A tests the relay endpoint over real HTTP against real files on disk, including the
// guard rails: extension allowlist (this must never become a generic local-file reader),
// cross-site refusal (a hostile page open on the stream PC probing files through <img>
// timing), Range support (Chromium requires 206s for <video> seek/loop), and the file://
// spelling. Part B tests the console wiring in jsdom: both fields, quote stripping, the
// web-URL field routing a pasted local path instead of handing file:// to the renderer raw,
// and Remove clearing the linked state.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const urlmod = require('url');
const relay = require('../relay.js');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

/* =============================== Part A: the relay =============================== */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ltmedia-'));
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');   // header-ish, content is irrelevant
const MP4_BYTES = Buffer.from('0123456789');                                 // 10 bytes, for range math
const pngPath = path.join(tmp, 'logo.png');
const mp4Path = path.join(tmp, 'loop.mp4');
const txtPath = path.join(tmp, 'secrets.txt');
fs.writeFileSync(pngPath, PNG_BYTES);
fs.writeFileSync(mp4Path, MP4_BYTES);
fs.writeFileSync(txtPath, 'not media');

const server = relay.createServer(path.join(__dirname, '..', 'lt.html'));

const get = (p, headers) => new Promise((resolve) => {
  const port = server.address().port;
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // happy path: a plain Windows path, byte-for-byte
  {
    const r = await get('/media?src=' + encodeURIComponent(pngPath));
    ok('serves a local image byte-for-byte', r.status === 200 && r.body.equals(PNG_BYTES));
    ok('...with its real content type', r.headers['content-type'] === 'image/png');
    ok('...nosniffed', r.headers['x-content-type-options'] === 'nosniff');
    ok('...and advertising ranges (video needs 206s to seek/loop)', r.headers['accept-ranges'] === 'bytes');
  }
  // the file:// spelling the UI also accepts
  {
    const r = await get('/media?src=' + encodeURIComponent(urlmod.pathToFileURL(mp4Path).href));
    ok('accepts the file:// spelling too', r.status === 200 && r.body.equals(MP4_BYTES));
    ok('...as video/mp4', r.headers['content-type'] === 'video/mp4');
  }
  // single-range requests, both forms
  {
    const r = await get('/media?src=' + encodeURIComponent(mp4Path), { Range: 'bytes=2-5' });
    ok('a bounded range answers 206 with exactly those bytes', r.status === 206 && r.body.toString() === '2345');
    ok('...and the right Content-Range', r.headers['content-range'] === 'bytes 2-5/10');
    const r2 = await get('/media?src=' + encodeURIComponent(mp4Path), { Range: 'bytes=-3' });
    ok('a suffix range answers the tail', r2.status === 206 && r2.body.toString() === '789');
    const r3 = await get('/media?src=' + encodeURIComponent(mp4Path), { Range: 'bytes=50-60' });
    ok('an unsatisfiable range answers 416', r3.status === 416);
  }
  // guard rails
  {
    const r = await get('/media?src=' + encodeURIComponent(txtPath));
    ok('a non-media extension is refused outright (never a generic file reader)', r.status === 403);
    const r2 = await get('/media?src=' + encodeURIComponent(path.join(tmp, 'missing.png')));
    ok('a missing file answers 404', r2.status === 404);
    const r3 = await get('/media?src=' + encodeURIComponent(pngPath), { 'sec-fetch-site': 'cross-site' });
    ok('a cross-site browser load is refused (probing via <img> timing)', r3.status === 403);
    const r4 = await get('/media?src=' + encodeURIComponent(pngPath), { origin: 'https://evil.example' });
    ok('a foreign origin is refused', r4.status === 403);
    const r5 = await get('/media?src=' + encodeURIComponent(tmp + path.sep));   // a directory
    ok('a directory is not servable', r5.status !== 200);
    const r6 = await get('/media');
    ok('a missing src answers 400', r6.status === 400);
    // an SVG must carry a no-script CSP: an <img> never runs SVG script, but a direct
    // navigation to /media would execute it on the relay's own origin, next to the
    // console's localStorage.
    const svgPath = path.join(tmp, 'mark.svg');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const r7 = await get('/media?src=' + encodeURIComponent(svgPath));
    ok('svg is served with a no-script CSP', r7.status === 200 && /default-src 'none'/.test(r7.headers['content-security-policy'] || ''));
  }
  await new Promise((r) => server.close(r));

  /* ============================ Part B: the console UI ============================ */
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} };
      w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
      w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
    }
  });
  const W = dom.window, D = W.document;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (n) => { if (!n) throw new Error('node not found'); n.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); };
  await sleep(300);

  ok('boxDefaults carries mediaLocal (so import/export sanitize keeps it)',
     W.createElement('text').box.mediaLocal === '');

  // select the scripture row so its inspector (and media panel) is up
  const row = [...D.querySelectorAll('.elrow')].find(r => r.querySelector('.ty') && r.querySelector('.ty').textContent === 'scripture');
  click(row.querySelector('.nm')); await sleep(100);

  const localInput = () => [...D.querySelectorAll('#panels input[type=text]')].find(i => /loop\.mp4/i.test(i.placeholder || ''));
  const urlInput = () => [...D.querySelectorAll('#panels input[type=text]')].find(i => /image or mp4/i.test(i.placeholder || ''));
  const savedBox = () => { const c = JSON.parse(W.localStorage.getItem('pplt.preview.v2')); return c.elements.find(e => e.type === 'scripture').box; };
  const setField = async (inp, v) => { inp.value = v; inp.dispatchEvent(new W.Event('input', { bubbles: true }));
    inp.dispatchEvent(new W.Event('change', { bubbles: true })); await sleep(120); };

  ok('the media panel offers a local-file field', !!localInput());

  // typing a local path links it through the relay
  await setField(localInput(), 'C:\\Church\\loop.mp4');
  ok('a local path stores the relay URL as the src',
     savedBox().mediaSrc === '/media?src=' + encodeURIComponent('C:\\Church\\loop.mp4'));
  ok('...and keeps the human-readable path', savedBox().mediaLocal === 'C:\\Church\\loop.mp4');
  ok('...and the renderer treats .mp4 as VIDEO through the relay URL',
     !!D.querySelector('#pv-scaler .lt-media video'));

  // "Copy as path" wraps in quotes — they must not reach the relay
  await setField(localInput(), '"C:\\Church\\ident.png"');
  ok('surrounding quotes are stripped', savedBox().mediaLocal === 'C:\\Church\\ident.png' &&
     savedBox().mediaSrc === '/media?src=' + encodeURIComponent('C:\\Church\\ident.png'));

  // a local path pasted into the WEB URL field routes to the same mechanism — a raw
  // file:// src silently shows nothing on an http page, in the field that looks like
  // exactly the right place to paste it.
  await setField(urlInput(), 'file:///C:/Church/bug.png');
  ok('a file:// paste in the web-URL field is routed to the local mechanism',
     /^\/media\?src=/.test(savedBox().mediaSrc));
  ok('...remembering the path', savedBox().mediaLocal === 'file:///C:/Church/bug.png' ||
     /bug\.png/.test(savedBox().mediaLocal));

  // a real web URL afterwards drops the local link entirely
  await setField(urlInput(), 'https://example.com/still.jpg');
  ok('a web URL replaces the local link', savedBox().mediaSrc === 'https://example.com/still.jpg');
  ok('...and clears the stored local path', savedBox().mediaLocal === '');

  // back to local, then Remove clears the whole linked state
  await setField(localInput(), 'C:\\Church\\loop.mp4');
  const removeBtn = [...D.querySelectorAll('#panels button')].find(b => /^Remove$/.test(b.textContent));
  click(removeBtn); await sleep(120);
  ok('Remove clears src, type and the local path',
     savedBox().mediaSrc === '' && savedBox().mediaLocal === '' && savedBox().mediaType === '');

  ok('no console errors', errors.length === 0);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('LOCAL-MEDIA RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors.slice(0, 5)) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('**FAIL** THREW: ' + e.message);
  console.log('LOCAL-MEDIA RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW');
  process.exit(1);
});
