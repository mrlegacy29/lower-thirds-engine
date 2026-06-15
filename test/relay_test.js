// Relay coverage: routing, /config round-trip, SSE replay, /pp proxy, and a
// REGRESSION for the headers-sent crash (upstream reset after headers piped).
const http = require('http');
const net = require('net');
const path = require('path');
const relay = require('../relay');

let pass = 0, fail = 0; const errors = [];
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function get(port, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (x) => {
      let b = ''; x.on('data', d => b += d);
      x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
      x.on('aborted', () => res({ status: x.statusCode || 0, body: b, aborted: true }));
      x.on('error', () => res({ status: x.statusCode || 0, body: b, errored: true }));
    });
    r.on('error', rej); r.end();
  });
}
function post(port, p, body) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (x) => {
      let b = ''; x.on('data', d => b += d); x.on('end', () => res({ status: x.statusCode, body: b }));
    });
    r.on('error', rej); r.end(body);
  });
}
function options(port, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'OPTIONS' }, (x) => { x.resume(); x.on('end', () => res({ status: x.statusCode })); });
    r.on('error', rej); r.end();
  });
}

(async () => {
  const server = relay.createServer(path.join(__dirname, '..', 'lt.html'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 1) serves the app at / and /output
  const root = await get(port, '/');
  ok('GET / returns 200 + app html', root.status === 200 && root.body.length > 5000);
  const outp = await get(port, '/output');
  ok('GET /output returns 200 + app html', outp.status === 200 && outp.body.length > 5000);

  // 2) OPTIONS preflight -> 204
  const opt = await options(port, '/config');
  ok('OPTIONS -> 204', opt.status === 204);

  // 3) /config POST round-trip + GET reflects it
  const cfg = JSON.stringify({ hello: 'world', _take: 1 });
  const pres = await post(port, '/config', cfg);
  ok('POST /config -> {ok:true}', /"ok":true/.test(pres.body));
  const gres = await get(port, '/config');
  ok('GET /config reflects last program', /"hello":"world"/.test(gres.body));

  // 4) SSE replays the last program to a late subscriber
  const sse = await new Promise((resolve) => {
    let acc = '';
    const r = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET' }, (x) => {
      x.on('data', d => { acc += d; if (/hello/.test(acc)) { r.destroy(); resolve(acc); } });
    });
    r.on('error', () => resolve(acc));
    setTimeout(() => { try { r.destroy(); } catch (e) {} resolve(acc); }, 1500);
    r.end();
  });
  ok('SSE /events replays last program to new subscriber', /"type":"program"/.test(sse) && /hello/.test(sse));

  // 5) 404 fallthrough
  const nf = await get(port, '/nope');
  ok('unknown path -> 404', nf.status === 404);

  // 6) /pp without target -> 400
  const noTarget = await get(port, '/pp');
  ok('/pp without target -> 400', noTarget.status === 400);

  // 7) /pp to a dead port -> clean 502 {error:'pp unreachable'} (no crash)
  const dead = await get(port, '/pp?target=' + encodeURIComponent('http://127.0.0.1:1/x'));
  ok('/pp dead upstream -> 502 pp unreachable', dead.status === 502 && /pp unreachable/.test(dead.body));

  // 8) REGRESSION: upstream sends 200 + partial body then RESETS the socket.
  //    Old code did res.writeHead(502) after headers were piped -> ERR_HTTP_HEADERS_SENT
  //    -> uncaught -> relay crash. The relay must survive and keep serving.
  const evil = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{partial');
    setTimeout(() => { try { sock.resetAndDestroy ? sock.resetAndDestroy() : sock.destroy(); } catch (e) {} }, 20);
  });
  await new Promise(r => evil.listen(0, '127.0.0.1', r));
  const evilPort = evil.address().port;
  const evilReq = http.request({ host: '127.0.0.1', port, path: '/pp?target=' + encodeURIComponent('http://127.0.0.1:' + evilPort + '/x'), method: 'GET' }, (x) => {
    x.on('data', () => {}); x.on('end', () => {}); x.on('aborted', () => {}); x.on('error', () => {});
  });
  evilReq.on('error', () => {});
  evilReq.end();
  await sleep(200);
  const stillUp = await get(port, '/');
  ok('relay SURVIVES upstream-reset-after-headers (no crash)', stillUp.status === 200);
  evil.close();

  server.close();
  console.log('RELAY RESULT  pass=' + pass + '  fail=' + fail + '  ERRORS=' + (errors.length ? JSON.stringify(errors) : 'NONE'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('**FAIL** relay suite THREW: ' + e.message); console.log('RELAY RESULT  pass=' + pass + '  fail=' + (fail + 1) + '  ERRORS=THREW'); process.exit(1); });
