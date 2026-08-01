// Live data binding — {{placeholders}} filled from bound sources.
//
// The decision worth pinning: an UNKNOWN placeholder is left VERBATIM, not blanked.
// A source that dies mid-service then shows "{{offering}}" on air rather than an empty
// box. That is deliberately ugly — a blank looks intentional and can go unnoticed for
// a whole service, whereas visible braces are obviously wrong.
//
// Also covered: the relay's /fetch proxy carries the same origin gate as /pp (it can
// reach anything the stream PC can), never echoes an upstream Content-Type, and caps
// the body so a bound source cannot exhaust memory.
const { JSDOM } = require('jsdom');
const http = require('http');
const path = require('path');
const relay = require('../relay');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

const errors = [];
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() {} close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.alert = () => {}; w.confirm = () => true;
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window;

function req(port, method, p, { origin } = {}) {
  return new Promise((res, rej) => {
    const headers = {}; if (origin) headers['Origin'] = origin;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (x) => {
      let b = ''; x.on('data', d => b += d);
      x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
    });
    r.on('error', rej); r.end();
  });
}

setTimeout(async () => {
  /* ============================ placeholder substitution ============================ */
  const V = { offering: '$12,450', name: 'Pastor Dave', 'service.count': '3' };
  ok('applyVars: substitutes a known placeholder', W.applyVars('Total: {{offering}}', V) === 'Total: $12,450');
  ok('applyVars: substitutes several', W.applyVars('{{name}} — {{offering}}', V) === 'Pastor Dave — $12,450');
  ok('applyVars: tolerates inner whitespace', W.applyVars('{{  offering  }}', V) === '$12,450');
  ok('applyVars: allows dots in a name', W.applyVars('{{service.count}}', V) === '3');
  ok('applyVars: text with no placeholder is untouched', W.applyVars('plain text', V) === 'plain text');
  ok('applyVars: non-strings pass through', W.applyVars(42, V) === 42);
  ok('applyVars: null vars leaves the text alone', W.applyVars('{{x}}', null) === '{{x}}');

  // the decision: unknown/empty stays visible rather than silently blanking
  ok('applyVars: an UNKNOWN placeholder is left verbatim', W.applyVars('{{nope}}', V) === '{{nope}}');
  ok('applyVars: an EMPTY value is left verbatim too', W.applyVars('{{e}}', { e: '' }) === '{{e}}');
  ok('applyVars: a partial brace is not treated as a placeholder', W.applyVars('{{unclosed', V) === '{{unclosed');

  ok('subVars: walks nested objects', (() => {
    const o = W.subVars({ a: 'hi {{name}}', b: { c: '{{offering}}' } }, V);
    return o.a === 'hi Pastor Dave' && o.b.c === '$12,450';
  })());
  ok('subVars: walks arrays', (() => {
    const o = W.subVars(['{{name}}', 'x'], V);
    return o[0] === 'Pastor Dave' && o[1] === 'x';
  })());
  ok('subVars: leaves non-strings alone', (() => {
    const o = W.subVars({ n: 5, b: true, z: null }, V);
    return o.n === 5 && o.b === true && o.z === null;
  })());

  /* ============================== source parsing ============================== */
  ok('csv: a name,value sheet becomes named placeholders', (() => {
    const v = W.parseDataSource('csv', 'offering,$12450\nattendance,320\nspeaker,Dave');
    return v.offering === '$12450' && v.attendance === '320' && v.speaker === 'Dave';
  })());
  // A two-column sheet is genuinely ambiguous — `offering,$12450` (name,value) and
  // `offering,attendance` over `$999,42` (header,row) are indistinguishable. So the
  // layout is an explicit choice, and the default only guesses where it is safe.
  ok('csv: a 2-column sheet DEFAULTS to name,value pairs', (() => {
    const v = W.parseDataSource('csv', 'offering,$12450\nattendance,320');
    return v.offering === '$12450' && v.attendance === '320';
  })());
  ok('csv: a WIDER sheet defaults to header + first data row', (() => {
    const v = W.parseDataSource('csv', 'a,b,c\n1,2,3');
    return v.a === '1' && v.b === '2' && v.c === '3';
  })());
  ok('csv: an explicit "table" layout overrides the default', (() => {
    const v = W.parseDataSource('csv', 'offering,attendance\n$999,42', null, 'table');
    return v.offering === '$999' && v.attendance === '42';
  })());
  ok('csv: an explicit "pairs" layout overrides the default', (() => {
    const v = W.parseDataSource('csv', 'a,b,c\n1,2,3', null, 'pairs');
    return v.a === 'b';
  })());
  ok('csv: quoted fields containing commas survive', (() => {
    const v = W.parseDataSource('csv', 'title,"Hello, world"\nx,1');
    return v.title === 'Hello, world';
  })());
  ok('csv: escaped double quotes survive', (() => {
    const v = W.parseDataSource('csv', 'q,"say ""hi"""\nx,1');
    return v.q === 'say "hi"';
  })());

  ok('json: a flat object becomes placeholders', (() => {
    const v = W.parseDataSource('json', '{"offering":"$500","count":12}');
    return v.offering === '$500' && v.count === '12';
  })());
  ok('json: a dotted path selects a sub-object', (() => {
    const v = W.parseDataSource('json', '{"data":{"totals":{"given":"$77"}}}', 'data.totals');
    return v.given === '$77';
  })());
  ok('json: nested objects are skipped, not stringified', (() => {
    const v = W.parseDataSource('json', '{"a":"1","deep":{"x":1}}');
    return v.a === '1' && v.deep === undefined;
  })());
  ok('json: malformed input yields nothing instead of throwing',
     Object.keys(W.parseDataSource('json', '{not json')).length === 0);

  ok('text: whole body becomes {{value}}', W.parseDataSource('text', '  hello  ').value === 'hello');
  ok('text: an over-long body is capped', W.parseDataSource('text', 'x'.repeat(9000)).value.length <= 500);

  /* ====================== substitution reaches the renderer ====================== */
  ok('defaultConfig ships a data.sources list (so Preview cannot drift from Program)',
     !!W.defaultConfig().data && Array.isArray(W.defaultConfig().data.sources));

  /* ============================ the relay /fetch proxy ============================ */
  const PORT = 7913, UPSTREAM = 7914;
  const up = http.createServer((q, s) => {
    if (q.url === '/big') { s.writeHead(200, { 'Content-Type': 'text/plain' }); return s.end('y'.repeat(3e6)); }
    // deliberately claims to be HTML — the relay must not pass that through
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end('offering,$12450\nattendance,320');
  });
  await new Promise(r => up.listen(UPSTREAM, '127.0.0.1', r));
  const server = relay.createServer(path.join(__dirname, '..', 'lt.html'));
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));

  const tgt = encodeURIComponent('http://127.0.0.1:' + UPSTREAM + '/sheet.csv');
  let r = await req(PORT, 'GET', '/fetch?target=' + tgt);
  ok('/fetch: a local caller gets the body', r.status === 200 && /offering,\$12450/.test(r.body));
  ok('/fetch: NEVER echoes the upstream Content-Type (text/html would run on our origin)',
     /text\/plain/.test(String(r.headers['content-type'] || '')));
  ok('/fetch: sets nosniff', /nosniff/.test(String(r.headers['x-content-type-options'] || '')));

  r = await req(PORT, 'GET', '/fetch?target=' + tgt, { origin: 'https://evil.example' });
  ok('/fetch: refuses a cross-origin caller', r.status === 403);
  r = await req(PORT, 'GET', '/fetch?target=' + tgt, { origin: 'null' });
  ok('/fetch: refuses a sandboxed-iframe (null) caller', r.status === 403);

  r = await req(PORT, 'GET', '/fetch');
  ok('/fetch: missing target is a 400', r.status === 400);
  r = await req(PORT, 'GET', '/fetch?target=' + encodeURIComponent('file:///etc/passwd'));
  ok('/fetch: refuses a non-http(s) scheme', r.status === 400);

  r = await req(PORT, 'GET', '/fetch?target=' + encodeURIComponent('http://127.0.0.1:' + UPSTREAM + '/big'));
  ok('/fetch: an over-large body is refused rather than buffered', r.status === 502);

  r = await req(PORT, 'GET', '/fetch?target=' + encodeURIComponent('http://127.0.0.1:9/nothing'));
  ok('/fetch: an unreachable source fails cleanly as 502', r.status === 502);

  // end-to-end: fetched CSV -> parsed -> substituted
  const body = (await req(PORT, 'GET', '/fetch?target=' + tgt)).body;
  const vars = W.parseDataSource('csv', body);
  ok('end to end: fetched CSV substitutes into text',
     W.applyVars('Given today: {{offering}} from {{attendance}}', vars) === 'Given today: $12450 from 320');

  server.close(); up.close();
  ok('nothing threw', errors.length === 0);
  console.log('\nDATABIND RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? errors.slice(0, 3).join(' | ') : 'NONE'));
  process.exit(fail ? 1 : 0);
}, 500);
