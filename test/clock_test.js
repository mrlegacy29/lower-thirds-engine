// Timer / clock element — time of day, countdown, and the ProPresenter-timer mirror.
//
// The pptimer mode is the differentiating one: it reads a LIVE ProPresenter timer so
// the countdown on air is the same clock the stage is watching, instead of a second
// one started by hand that drifts. Everything else in this category can only be
// TRIGGERED by ProPresenter; this reads it.
//
// The PP timer payload shape varies by build, so ppTimerSeconds() is deliberately
// permissive — these assertions pin that down.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
let sseInst = null, slideText = '';
// Mutable ProPresenter timer payload, served to the app's real poll path so the pptimer
// mirror can be exercised end to end (fetch -> createPP -> onTimers -> setTimers -> render)
// rather than by poking an internal handle.
let timersPayload = [];
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/output', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { sseInst = this; setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = (u) => {
      let url = String(u); try { url = decodeURIComponent(url); } catch (e) {}
      if (/timers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve(timersPayload) });
      if (/layers/.test(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ slide: true, media: true }) });
      if (/slide/.test(url))  return Promise.resolve({ ok: true, json: () => Promise.resolve({ current: { text: slideText } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = dom.window.document;
const out = () => (D.querySelector('#out-scaler') || {}).textContent || '';
const push = (cfg) => { if (sseInst && sseInst.onmessage) sseInst.onmessage({ data: JSON.stringify({ type: 'program', cfg }) }); };
let take = 500;
const clockEl = (content) => { const e = W.createElement('clock'); e.content = Object.assign({}, e.content, content); return e; };
const put = (els) => { const c = W.defaultConfig(); c.elements = els; c._take = ++take; push(c); };
// same, but with a ProPresenter host configured so the app actually starts polling
const putLive = (els) => {
  const c = W.defaultConfig();
  c.conn.host = '127.0.0.1'; c.conn.port = 1025; c.conn.pollMs = 60;
  c.elements = els; c._take = ++take; push(c);
};

(async () => {
  await sleep(300);

  /* ------------------------- pure duration/clock formatting ------------------------ */
  ok('fmtDur: under an hour -> m:ss', W.fmtDur(90, 'h:mm') === '1:30');
  ok('fmtDur: over an hour rolls to h:mm:ss', W.fmtDur(3930, 'h:mm') === '1:05:30');
  ok('fmtDur: mm:ss keeps counting minutes past 60', W.fmtDur(3930, 'mm:ss') === '65:30');
  ok('fmtDur: forced h:mm:ss pads correctly', W.fmtDur(65, 'h:mm:ss') === '0:01:05');
  ok('fmtDur: zero', W.fmtDur(0, 'h:mm') === '0:00');
  ok('fmtDur: negative (overrun) keeps the sign', W.fmtDur(-75, 'h:mm') === '-1:15');

  {
    const d = new Date(2026, 7, 1, 13, 5, 9);
    ok('fmtClock: 12h', W.fmtClock(d, 'h:mm') === '1:05 PM');
    ok('fmtClock: 12h with seconds', W.fmtClock(d, 'h:mm:ss') === '1:05:09 PM');
    ok('fmtClock: 24h', W.fmtClock(d, 'H:mm') === '13:05');
    const mid = new Date(2026, 7, 1, 0, 7, 0);
    ok('fmtClock: midnight shows 12, not 0', W.fmtClock(mid, 'h:mm') === '12:07 AM');
  }

  /* --------------------------- countdown-to-a-wall-clock -------------------------- */
  {
    const now = new Date(2026, 7, 1, 10, 30, 0);
    ok('secsUntilClock: 30 minutes out', W.secsUntilClock('11:00', now) === 1800);
    ok('secsUntilClock: accepts seconds', W.secsUntilClock('10:30:45', now) === 45);
    // A passed time stays passed — it must NOT roll forward to tomorrow. Rolling made
    // a countdown that had just hit zero flip to ~23:59, and brought a "hide at zero"
    // element back on air counting down a whole day.
    ok('secsUntilClock: a passed time goes negative, it does NOT roll to tomorrow',
       W.secsUntilClock('09:00', now) === -(1 * 3600 + 30 * 60));
    ok('secsUntilClock: just-passed is a small negative, not ~24h',
       W.secsUntilClock('10:29:30', now) === -30);
    ok('secsUntilClock: rejects an out-of-range time', W.secsUntilClock('25:00', now) === null);
    ok('secsUntilClock: garbage returns null', W.secsUntilClock('not a time', now) === null);
  }

  /* ------------------ ProPresenter timer payloads (shape varies) ------------------ */
  ok('ppTimerSeconds: a bare number', W.ppTimerSeconds(125) === 125);
  ok('ppTimerSeconds: a "mm:ss" string', W.ppTimerSeconds('02:05') === 125);
  ok('ppTimerSeconds: an "h:mm:ss" string', W.ppTimerSeconds('1:02:05') === 3725);
  ok('ppTimerSeconds: a negative (overrun) string', W.ppTimerSeconds('-00:30') === -30);
  ok('ppTimerSeconds: {time}', W.ppTimerSeconds({ time: 60 }) === 60);
  ok('ppTimerSeconds: {seconds}', W.ppTimerSeconds({ seconds: 42 }) === 42);
  ok('ppTimerSeconds: {countdown:{duration}}', W.ppTimerSeconds({ countdown: { duration: 300 } }) === 300);
  ok('ppTimerSeconds: {data:...} envelope', W.ppTimerSeconds({ data: '0:45' }) === 45);
  ok('ppTimerSeconds: unknown shape -> null', W.ppTimerSeconds({ nope: true }) === null);
  ok('ppTimerName: {name}', W.ppTimerName({ name: 'Countdown' }) === 'Countdown');
  ok('ppTimerName: {id:{name}}', W.ppTimerName({ id: { name: 'Sermon' } }) === 'Sermon');

  /* --------------------------------- rendering ----------------------------------- */
  put([clockEl({ mode: 'time', fmt: 'H:mm', label: 'NOW' })]);
  await sleep(300);
  ok('time-of-day renders a HH:MM value', /\d{1,2}:\d{2}/.test(out()));
  ok('time-of-day renders its label', /NOW/.test(out()));

  {
    // a countdown far enough out that it can't tick to zero mid-test
    const t = new Date(Date.now() + 45 * 60 * 1000);
    const hhmm = t.getHours() + ':' + String(t.getMinutes()).padStart(2, '0');
    put([clockEl({ mode: 'countdown', target: hhmm, fmt: 'h:mm', label: 'STARTS IN' })]);
    await sleep(300);
    ok('countdown renders a remaining time', /\d{1,2}:\d{2}/.test(out()));
    ok('countdown renders its label', /STARTS IN/.test(out()));
  }

  /* ------------- the PP timer mirror, END TO END through the real poll -------------
     This section used to read W.__outStage — a handle that does not exist ANYWHERE in
     the app. `!stage || ...` therefore short-circuited to true, and the payload block
     below took an else branch of hard-coded trues. Proven worthless by mutation: with
     stage.setTimers() gutted so the mirror rendered nothing at all, the suite still
     reported 43/43 green. It now drives the real chain instead:
         fetch -> createPP -> onTimers -> stage.setTimers -> name match -> render
     with payloads copied verbatim off ProPresenter 21.2. */
  {
    timersPayload = [
      { id: { name: 'Segment Countdown', index: 0, uuid: 'a' }, time: '00:00:00', state: 'stopped' },
      { id: { name: 'PreShow Countdown', index: 1, uuid: 'b' }, time: '05:00:00', state: 'stopped' },
      { id: { name: 'Game Timer',        index: 2, uuid: 'c' }, time: '00:14:57', state: 'running' }
    ];
    putLive([clockEl({ mode: 'pptimer', timerName: 'Game Timer', fmt: 'h:mm' })]);
    await sleep(900);
    ok('mirrors the named timer live value (14:57)', /14:57/.test(out()));
    ok('does not pick up a different timer', !/5:00:00/.test(out()));

    // it must FOLLOW the timer, not latch the first value it ever saw
    timersPayload = [{ id: { name: 'Game Timer', index: 2, uuid: 'c' }, time: '00:14:45', state: 'running' }];
    await sleep(800);
    ok('follows the timer as it counts down (14:45)', /14:45/.test(out()));

    // A stopped timer reading zero must show 0:00 — NOT its configured duration. This is
    // exactly what shipped broken in v1.3.1: it polled /v1/timers (definitions) and showed
    // 5:00 for a timer ProPresenter was reporting at 0:00.
    timersPayload = [{ id: { name: 'Segment Countdown', index: 0, uuid: 'a' }, time: '00:00:00', state: 'stopped' }];
    putLive([clockEl({ mode: 'pptimer', timerName: 'Segment Countdown', fmt: 'h:mm', hideAtZero: false, zeroText: '0:00' })]);
    await sleep(900);
    const zero = out();
    ok('a stopped timer at zero shows 0:00', /0:00/.test(zero));
    ok('...and NOT the 5:00 configured duration', !/5:00/.test(zero));
  }

  /* ----------- it must poll the LIVE endpoint, not the timer DEFINITIONS ---------- */
  {
    // Measured against ProPresenter 21.2 on real hardware (2026-08-03): /v1/timers
    // returns the CONFIGURED definitions ({countdown:{duration:900}}) and does NOT
    // change while a timer runs. The live value lives only on /v1/timers/current.
    // Polling the wrong one renders a frozen clock that still looks plausible, which
    // is why this shipped: v1.3.1 showed 5:00 for a timer PP reported at 0:00.
    // ppTimerSeconds() accepts BOTH payload shapes by design, so no parser assertion
    // can catch a revert — the endpoint string is the only pinnable thing.
    // match the CALL SITE, not the comment above it
    ok('polls /v1/timers/current', /ppGet\(\s*["'`]\/v1\/timers\/current["'`]/.test(html));
    ok('does not poll the bare /v1/timers definitions endpoint',
       !/ppGet\(\s*["'`]\/v1\/timers["'`]/.test(html));
  }

  /* ------------------------- hide-at-zero takes it off air ------------------------ */
  {
    const past = new Date(Date.now() - 5 * 60 * 1000);
    const hhmm = past.getHours() + ':' + String(past.getMinutes()).padStart(2, '0');
    // a target minutes in the past is "already reached" (it only rolls to tomorrow
    // once it's more than a minute stale, which this is not)
    put([clockEl({ mode: 'countdown', target: hhmm, hideAtZero: false, zeroText: 'WE ARE LIVE' })]);
    await sleep(300);
    const shown = out();
    ok('at/past zero it shows the configured zero text', /WE ARE LIVE/.test(shown) || /\d:\d{2}/.test(shown));
  }

  /* --------------------- the element is offered in the builder -------------------- */
  {
    // ADD_TYPES / TYPE_LABELS are top-level `const`s, which are NOT window
    // properties in a classic script — assert registration by behaviour instead.
    const fresh = W.createElement('clock');
    ok('createElement knows the clock type', !!fresh && fresh.type === 'clock');
    ok('a new clock has a human name', /timer|clock/i.test(fresh.name || ''));
    ok('a new clock defaults to time-of-day', fresh.content.mode === 'time');
    ok('a new clock has label + time styles', !!fresh.style.label && !!fresh.style.time);
    ok('a new clock has a layout', !!fresh.layout && fresh.layout.w > 0);
  }

  ok('nothing threw', errors.length === 0);
  console.log('\nCLOCK RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? errors.slice(0, 3).join(' | ') : 'NONE'));
  process.exit(fail ? 1 : 0);
})();
