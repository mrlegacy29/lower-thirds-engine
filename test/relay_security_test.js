// Relay origin policy + honest responses.
//
// These lock in fixes for two holes that were REPRODUCED against the running relay:
//   1. POST /config answered every origin with Access-Control-Allow-Origin: *, so any page
//      open in any browser on the stream PC could replace the on-air program mid-service.
//      CORS does not protect a state-changing POST — the browser only blocks reading the
//      RESPONSE; the write already happened. So the origin must be checked and refused.
//   2. /pp echoed the upstream Content-Type with wildcard CORS, so any http:// host could
//      serve HTML/JS on the relay's OWN origin, and any page could read church-LAN hosts
//      back through the proxy.
//
// "null" (file:// and, crucially, sandboxed iframes on ANY site) is refused for writes —
// otherwise a hostile page just wraps its request in a sandboxed frame and the gate is moot.
const http = require('http');
const path = require('path');
const relay = require('../relay');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

function req(port, method, p, { origin, body } = {}) {
  return new Promise((res, rej) => {
    const headers = {};
    if (body != null) headers['Content-Type'] = 'application/json';
    if (origin) headers['Origin'] = origin;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (x) => {
      let b = ''; x.on('data', d => b += d);
      x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
      x.on('error', () => res({ status: x.statusCode || 0, body: b, errored: true }));
    });
    r.on('error', rej);
    r.end(body == null ? undefined : body);
  });
}

(async () => {
  const PORT = 7911;
  const server = relay.createServer(path.join(__dirname, '..', 'lt.html'));
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const GOOD = JSON.stringify({ elements: [{ id: 'good', type: 'text', content: { text: 'LEGIT' } }], _take: 1 });
  const EVIL = JSON.stringify({ elements: [{ id: 'pwn', type: 'text', content: { text: 'HIJACKED' } }], _take: 99 });

  /* ---------- the legitimate paths still work ---------- */
  let r = await req(PORT, 'POST', '/config', { origin: 'http://localhost:' + PORT, body: GOOD });
  ok('local origin may write /config', r.status === 200 && /"ok":true/.test(r.body));

  r = await req(PORT, 'POST', '/config', { body: GOOD });   // no Origin: curl, OBS, tests
  ok('a request with no Origin may write /config', r.status === 200);

  r = await req(PORT, 'POST', '/config', { origin: 'http://127.0.0.1:' + PORT, body: GOOD });
  ok('127.0.0.1 origin may write /config', r.status === 200);

  /* ---------- the attack is refused ---------- */
  r = await req(PORT, 'POST', '/config', { origin: 'https://evil.example', body: EVIL });
  ok('cross-origin write to /config is refused', r.status === 403);

  r = await req(PORT, 'POST', '/config', { origin: 'null', body: EVIL });
  ok('sandboxed-iframe (Origin: null) write is refused', r.status === 403);

  r = await req(PORT, 'POST', '/config', { origin: 'http://localhost.evil.example', body: EVIL });
  ok('a look-alike host (localhost.evil.example) is refused', r.status === 403);

  // the on-air config must be untouched by all of the above
  r = await req(PORT, 'GET', '/config');
  ok('the program config survived the attacks', /LEGIT/.test(r.body) && !/HIJACKED/.test(r.body));

  /* ---------- no wildcard CORS anywhere ---------- */
  r = await req(PORT, 'GET', '/config', { origin: 'https://evil.example' });
  ok('no wildcard ACAO on /config for a remote origin', r.headers['access-control-allow-origin'] !== '*');
  ok('a remote origin is not echoed back as allowed', r.headers['access-control-allow-origin'] !== 'https://evil.example');

  r = await req(PORT, 'GET', '/config', { origin: 'http://localhost:' + PORT });
  ok('a local origin IS echoed back as allowed', r.headers['access-control-allow-origin'] === 'http://localhost:' + PORT);
  ok('Vary: Origin is set so caches cannot mix the two', /origin/i.test(String(r.headers['vary'] || '')));

  r = await req(PORT, 'OPTIONS', '/config', { origin: 'https://evil.example' });
  ok('preflight does not hand a remote origin a wildcard', r.headers['access-control-allow-origin'] !== '*');

  /* ---------- /pp is not an open proxy ---------- */
  r = await req(PORT, 'GET', '/pp?target=http://127.0.0.1:' + PORT + '/config', { origin: 'https://evil.example' });
  ok('cross-origin use of the /pp proxy is refused', r.status === 403);

  // reachable locally, and never echoes the upstream content type
  r = await req(PORT, 'GET', '/pp?target=http://127.0.0.1:' + PORT + '/status');
  ok('/pp still works for a local caller', r.status === 200);
  ok('/pp always answers application/json, never the upstream type',
     /application\/json/.test(String(r.headers['content-type'] || '')));
  ok('/pp sets nosniff', /nosniff/.test(String(r.headers['x-content-type-options'] || '')));

  /* ---------- honest responses ---------- */
  r = await req(PORT, 'POST', '/config', { body: '{"elements":[' });
  ok('malformed JSON is reported as a failure, not a false 200', r.status === 400 && /bad json/.test(r.body));

  r = await req(PORT, 'GET', '/config');
  ok('a malformed POST did not clobber the good program', /LEGIT/.test(r.body));

  /* ---------- /status separates outputs from consoles ---------- */
  r = await req(PORT, 'GET', '/status');
  const st = JSON.parse(r.body);
  ok('/status reports an output count', typeof st.clients === 'number');
  ok('/status reports consoles separately', typeof st.consoles === 'number');
  ok('/status starts with zero outputs', st.clients === 0);

  server.close();
  console.log('\nRELAY-SECURITY RESULT  pass=' + pass + '  fail=' + fail);
  process.exit(fail ? 1 : 0);
})();
