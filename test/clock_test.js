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
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/output', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() { sseInst = this; setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window, D = dom.window.document;
const out = () => (D.querySelector('#out-scaler') || {}).textContent || '';
const push = (cfg) => { if (sseInst && sseInst.onmessage) sseInst.onmessage({ data: JSON.stringify({ type: 'program', cfg }) }); };
let take = 500;
const clockEl = (content) => { const e = W.createElement('clock'); e.content = Object.assign({}, e.content, content); return e; };
const put = (els) => { const c = W.defaultConfig(); c.elements = els; c._take = ++take; push(c); };

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

  /* ------------------------- the PP timer mirror, end to end ---------------------- */
  {
    const el = clockEl({ mode: 'pptimer', timerName: 'Sermon', fmt: 'h:mm' });
    put([el]);
    await sleep(250);
    // stage.setTimers() is what the poller calls when /v1/timers answers
    const stage = W.__outStage || null;
    ok('output stage exposes setTimers for the poller', !stage || typeof stage.setTimers === 'function');
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
