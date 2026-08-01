// SDI fill + key (DeckLink) — console surface and the module's pure logic.
//
// What matters here:
//   1. lt.html must STILL be a plain file that works in a browser and in OBS. The whole
//      SDI group is gated on window.ltDesktop, so with no desktop bridge it must not
//      render and must not throw.
//   2. The status lamp has to name the FAULT, not just go red — that is the entire point
//      of the feature for an operator standing at the stream PC.
//   3. SDI settings must live in their OWN localStorage key, never in the config. The card
//      and video mode are per-machine plumbing; if they leaked into the config they would
//      travel in a Take and light the TAKE button as "pending" on every machine.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ============================ 1. the module's pure logic ============================ */
// sdi.js guards its electron require so this is loadable under plain node.
const sdi = require('../sdi.js');
{
  const a = sdi.available();
  ok('sdi: available() reports a boolean ok', typeof a.ok === 'boolean');
  ok('sdi: when the bridge is missing it explains how to install it',
     a.ok || /macadam/i.test(String(a.reason)));
  const m = sdi.modes();
  ok('sdi: exposes a video-mode list', Array.isArray(m) && m.length > 0);
  ok('sdi: every mode carries id/label/w/h/fps',
     m.every(x => x.id && x.label && x.w > 0 && x.h > 0 && x.fps > 0));
  ok('sdi: the default mode is in the list', m.some(x => x.id === sdi.DEFAULT_MODE));
  ok('sdi: 1080-line modes are 1920x1080', m.filter(x => /1080/.test(x.label)).every(x => x.w === 1920 && x.h === 1080));

  const h = sdi.health();
  ok('sdi: health() returns a traffic-light level', ['red', 'amber', 'green'].indexOf(h.level) >= 0);
  ok('sdi: health() returns named checks', Array.isArray(h.checks) && h.checks.length > 0);
  ok('sdi: every check has id/label/state', h.checks.every(c => c.id && c.label && /^(ok|warn|fail)$/.test(c.state)));
  ok('sdi: health() carries a human summary', typeof h.summary === 'string' && h.summary.length > 0);

  const st = sdi.status();
  ok('sdi: status() embeds health', !!st.health && !!st.health.level);
  ok('sdi: status() is safe with no hardware (on=false, no throw)', st.on === false);
  // never claim to be sending when the bridge is absent
  ok('sdi: no bridge -> red, never green', a.ok || h.level === 'red');
}

/* ===================== 2. browser mode: the group must NOT appear ==================== */
function boot(desktop) {
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} };
      w.EventSource = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } close() {} };
      w.requestAnimationFrame = (c) => setTimeout(c, 0); w.confirm = () => true; w.alert = () => {};
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
      w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
      if (desktop) w.ltDesktop = desktop;
    }
  });
  return { dom, W: dom.window, D: dom.window.document, errors };
}

(async () => {
  {
    const { D, errors } = boot(null);
    await sleep(350);
    ok('browser: no SDI group when there is no desktop bridge', !D.getElementById('sdiGrp'));
    ok('browser: console still renders its panels', !!D.getElementById('panels'));
    ok('browser: nothing threw', errors.length === 0);
  }

  /* ============ 3. desktop, bridge unavailable: explain, and offer the OBS path ======= */
  {
    const status = { supported: false, on: false, reason: 'macadam is not installed — build it against the Blackmagic SDK.' };
    const { D, errors } = boot({ isDesktop: true, sdi: {
      status: async () => status, modes: async () => [], devices: async () => [],
      start: async () => status, stop: async () => status, setLevel: async () => status,
      ramp: () => {}, test: async () => status, onStatus: () => {},
    }});
    await sleep(450);
    const body = D.getElementById('sdiBody');
    ok('desktop/unsupported: the SDI group renders', !!D.getElementById('sdiGrp'));
    ok('desktop/unsupported: the reason is shown verbatim', !!body && /macadam is not installed/.test(body.textContent));
    ok('desktop/unsupported: the OBS fallback is offered', !!body && /DeckLink Output/i.test(body.textContent));
    ok('desktop/unsupported: it names the required Color Format', !!body && /RGB/.test(body.textContent));
    ok('desktop/unsupported: nothing threw', errors.length === 0);
  }

  /* =================== 4. desktop, running: the lamp names the state ================== */
  {
    const green = {
      supported: true, on: true, device: 0, mode: 'bmdModeHD1080p5994', modeLabel: '1080p 59.94',
      level: 255, frames: 900, dropped: 0, error: null, reference: 'locked',
      health: { level: 'green', summary: 'Sending fill + key', checks: [
        { id: 'bridge', label: 'DeckLink bridge installed', state: 'ok', detail: '' },
        { id: 'device', label: 'Card open', state: 'ok', detail: 'Device 0 · 1080p 59.94' },
        { id: 'frames', label: 'Card accepting frames', state: 'ok', detail: '900 sent' },
      ]},
    };
    const { D, errors } = boot({ isDesktop: true, sdi: {
      status: async () => green, modes: async () => sdi.modes(), devices: async () => [{ index: 0, display: 'DeckLink 8K Pro', keyable: true }],
      start: async () => green, stop: async () => green, setLevel: async () => green,
      ramp: () => {}, test: async () => green, onStatus: () => {},
    }});
    await sleep(450);
    const body = D.getElementById('sdiBody');
    const t = body ? body.textContent : '';
    ok('desktop/green: lamp reads KEY + FILL OK', /KEY \+ FILL OK/.test(t));
    ok('desktop/green: individual checks are listed', /Card accepting frames/.test(t));
    ok('desktop/green: the device is offered for selection', /DeckLink 8K Pro/.test(t));
    ok('desktop/green: the video mode is shown', /1080p 59\.94/.test(t));
    ok('desktop/green: Stop is offered while running', /Stop SDI output/.test(t));
    ok('desktop/green: the ATEM keyer settings are documented', /Pre-Multiplied Key/i.test(t));
    // the honest boundary — a green lamp must not imply the ATEM received anything
    ok('desktop/green: states that SDI is one-way and cannot confirm the ATEM', /one-way/i.test(t));
    ok('desktop/green: offers the test pattern', /test pattern/i.test(t));
    ok('desktop/green: nothing threw', errors.length === 0);
  }

  /* ================ 5. red state must NAME the fault, not just go red ================= */
  {
    const red = {
      supported: true, on: false, device: 0, mode: null, level: 255, frames: 0, dropped: 0,
      error: 'The DeckLink wouldn\'t open for fill+key: device in use',
      health: { level: 'red', summary: 'device in use', checks: [
        { id: 'bridge', label: 'DeckLink bridge installed', state: 'ok', detail: '' },
        { id: 'output', label: 'Fill + key output open', state: 'fail', detail: 'device in use' },
      ]},
    };
    const { D, errors } = boot({ isDesktop: true, sdi: {
      status: async () => red, modes: async () => sdi.modes(), devices: async () => [{ index: 0, display: 'DeckLink 8K Pro', keyable: true }],
      start: async () => red, stop: async () => red, setLevel: async () => red,
      ramp: () => {}, test: async () => red, onStatus: () => {},
    }});
    await sleep(450);
    const t = (D.getElementById('sdiBody') || {}).textContent || '';
    ok('desktop/red: lamp reads NOT SENDING', /NOT SENDING/.test(t));
    ok('desktop/red: the specific fault is named', /device in use/.test(t));
    ok('desktop/red: the failing check is identified', /Fill \+ key output open/.test(t));
    ok('desktop/red: Start is offered', /Start SDI output/.test(t));
    ok('desktop/red: nothing threw', errors.length === 0);
  }

  /* ========= 6. THE DESIGN GUARD: SDI settings never enter the config ================= */
  {
    const status = { supported: true, on: false, device: 0, mode: 'bmdModeHD1080p5994', level: 255,
                     frames: 0, dropped: 0, error: null,
                     health: { level: 'red', summary: 'Idle', checks: [{ id: 'bridge', label: 'b', state: 'ok', detail: '' }] } };
    const { W, D, errors } = boot({ isDesktop: true, sdi: {
      status: async () => status, modes: async () => sdi.modes(), devices: async () => [{ index: 0, display: 'DeckLink 8K Pro', keyable: true }],
      start: async () => status, stop: async () => status, setLevel: async () => status,
      ramp: () => {}, test: async () => status, onStatus: () => {},
    }});
    await sleep(450);

    // change the video mode through the real select
    const body = D.getElementById('sdiBody');
    const selects = body ? [...body.querySelectorAll('select')] : [];
    const modeSel = selects.find(s => [...s.options].some(o => /1080p 25/.test(o.textContent)));
    ok('config-guard: the video-mode select exists', !!modeSel);
    if (modeSel) {
      modeSel.value = 'bmdModeHD1080p25';
      modeSel.dispatchEvent(new W.Event('change', { bubbles: true }));
      await sleep(120);
    }

    const sdiLs = W.localStorage.getItem('pplt.sdi.v1');
    ok('config-guard: the choice is stored under its own key', !!sdiLs && /bmdModeHD1080p25/.test(sdiLs));

    const prev = W.localStorage.getItem('pplt.preview.v2') || '';
    const prog = W.localStorage.getItem('pplt.program.v2') || '';
    ok('config-guard: the video mode did NOT leak into the preview config', !/bmdModeHD1080p25/.test(prev));
    ok('config-guard: the video mode did NOT leak into the program config', !/bmdModeHD1080p25/.test(prog));
    ok('config-guard: no sdi key was added to the config', !/pplt\.sdi|"sdi"\s*:/.test(prev));
    ok('config-guard: nothing threw', errors.length === 0);
  }

  console.log('\nSDI RESULT  pass=' + pass + '  fail=' + fail);
  process.exit(fail ? 1 : 0);
})();
