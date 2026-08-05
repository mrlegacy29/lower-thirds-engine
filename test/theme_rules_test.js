// Brand theme tokens + automation rules.
//
// THEME: any style colour/font may hold a token ("@accent", "@display") instead of a
// literal, so one change restyles every element pointing at it. Literals must keep
// working untouched — nothing existing is forced to migrate.
//
// RULES: "while the live slide matches ___, show/hide ___". A rule takes FULL control
// of its target while enabled — on a match it applies the action, otherwise the
// opposite. Half-control would be useless: the element's own content still exists, so
// it would simply sit on air the whole time. On a CLEAR every rule releases its
// target, so automation can never pin something on air after Clear All.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
let sseInst = null;
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
const push = (cfg) => { if (sseInst && sseInst.onmessage) sseInst.onmessage({ data: JSON.stringify({ type: 'program', cfg }) }); };
let take = 900;

(async () => {
  await sleep(300);

  /* ================================ theme tokens ================================ */
  {
    const th = { accent: '#ff0000', ink: '#00ff00', display: 'Impact,sans-serif' };
    ok('resolveTok: a token resolves from the theme', W.resolveTok('@accent', th) === '#ff0000');
    ok('resolveTok: a second token', W.resolveTok('@ink', th) === '#00ff00');
    ok('resolveTok: a font token', W.resolveTok('@display', th) === 'Impact,sans-serif');
    ok('resolveTok: a LITERAL passes straight through', W.resolveTok('#123456', th) === '#123456');
    ok('resolveTok: a literal font passes through', W.resolveTok('Georgia,serif', th) === 'Georgia,serif');
    ok('resolveTok: an unknown token falls back to the shipped default',
       W.resolveTok('@muted', th) === W.defaultTheme().muted);
    ok('resolveTok: a totally unknown token returns itself rather than blanking',
       W.resolveTok('@nope', th) === '@nope');
    ok('resolveTok: non-strings are untouched', W.resolveTok(42, th) === 42);
    ok('resolveTok: null theme still resolves from defaults',
       W.resolveTok('@accent', null) === W.defaultTheme().accent);
    ok('defaultConfig ships a theme', !!W.defaultConfig().theme);
    ok('defaultConfig ships an empty rules list', Array.isArray(W.defaultConfig().rules));
  }

  /* -------- a token in a style actually reaches the rendered element -------- */
  {
    const cfg = W.defaultConfig();
    cfg.theme = Object.assign(W.defaultTheme(), { accent: 'rgb(255, 0, 0)', ink: 'rgb(0, 0, 255)' });
    const s = W.createElement('scripture');
    s.source = { kind: 'manual' };
    s.content = { ref: 'John 3:16', translation: '', body: 'For God so loved the world.' };
    s.style.ref.color = '@accent';
    s.style.body.color = '@ink';
    cfg.elements = [s]; cfg._take = ++take;
    push(cfg); await sleep(350);

    const refNode = D.querySelector('#out-scaler .r-ref');
    const bodyNode = D.querySelector('#out-scaler .r-body');
    ok('token render: the reference node exists', !!refNode);
    ok('token render: @accent resolved onto the reference',
       !!refNode && refNode.style.color === 'rgb(255, 0, 0)');
    ok('token render: @ink resolved onto the verse body',
       !!bodyNode && bodyNode.style.color === 'rgb(0, 0, 255)');
    // Checking style.color for "@" CANNOT fail: jsdom's CSS parser rejects "@accent" as an
    // invalid colour and leaves the property empty, so the raw token is never observable
    // there whatever the code does. Check the resolver's OUTPUT, which is the only place a
    // leak is actually visible.
    ok('token resolver never returns a raw @token',
       W.tok('@accent').indexOf('@') < 0 && W.tok('@ink').indexOf('@') < 0 &&
       W.tok('@display').indexOf('@') < 0);
    ok('token resolver passes literals straight through', W.tok('#ff8800') === '#ff8800');
    ok('token resolver leaves an UNKNOWN token alone rather than blanking it',
       W.tok('@nosuchtoken') === '@nosuchtoken');
  }

  /* -------- changing ONLY the theme restyles without touching the element -------- */
  {
    const cfg = W.defaultConfig();
    cfg.theme = Object.assign(W.defaultTheme(), { accent: 'rgb(1, 2, 3)' });
    const s = W.createElement('scripture');
    s.source = { kind: 'manual' };
    s.content = { ref: 'Psalm 23:1', translation: '', body: 'The LORD is my shepherd.' };
    s.style.ref.color = '@accent';
    cfg.elements = [s]; cfg._take = ++take;
    push(cfg); await sleep(300);
    const before = D.querySelector('#out-scaler .r-ref').style.color;

    const cfg2 = JSON.parse(JSON.stringify(cfg));
    cfg2.theme.accent = 'rgb(9, 8, 7)';        // ONLY the theme changes
    cfg2._take = ++take;
    push(cfg2); await sleep(300);
    const after = D.querySelector('#out-scaler .r-ref').style.color;

    ok('rebrand: the element restyles from a theme-only change', before !== after);
    ok('rebrand: it took the new accent', after === 'rgb(9, 8, 7)');
  }

  /* -------- a literal colour must NOT be affected by the theme -------- */
  {
    const cfg = W.defaultConfig();
    cfg.theme = Object.assign(W.defaultTheme(), { accent: 'rgb(255, 0, 0)' });
    const s = W.createElement('scripture');
    s.source = { kind: 'manual' };
    s.content = { ref: 'Romans 8:28', translation: '', body: 'And we know.' };
    s.style.ref.color = 'rgb(12, 34, 56)';     // deliberately literal
    cfg.elements = [s]; cfg._take = ++take;
    push(cfg); await sleep(300);
    ok('literals are untouched by the theme',
       D.querySelector('#out-scaler .r-ref').style.color === 'rgb(12, 34, 56)');
  }

  /* ================================ rules engine ================================ */
  const R = W.evalRules;
  ok('evalRules is reachable', typeof R === 'function');

  {
    const show = [{ id: 'r1', enabled: true, on: 'text', match: 'contains', pattern: 'Welcome', act: 'show', target: 'E1' }];
    ok('contains: match -> show', R(show, { text: 'Welcome home', cleared: false }).E1 === true);
    ok('contains: no match -> the rule HIDES it (full control)',
       R(show, { text: 'Sermon point one', cleared: false }).E1 === false);
    ok('contains: matching is case-insensitive', R(show, { text: 'WELCOME HOME', cleared: false }).E1 === true);

    const hide = [{ id: 'r2', enabled: true, on: 'text', match: 'contains', pattern: 'Offering', act: 'hide', target: 'E1' }];
    ok('act=hide: match -> hidden', R(hide, { text: 'Offering time', cleared: false }).E1 === false);
    ok('act=hide: no match -> shown', R(hide, { text: 'Anything else', cleared: false }).E1 === true);

    /* ---- TWO rules on the SAME element ----
       evalRules assigned out[target] outright, so the LAST rule silently voided every
       earlier one: a rule that MATCHED could be overruled by one that did not, and the
       first rule became completely inert. Accumulated per target now. */
    const mk = (o) => Object.assign({ enabled: true, target: 'E1', on: 'text', match: 'contains', act: 'show' }, o);
    ok('two show-rules: the FIRST matching is enough',
       R([mk({ id: 'a', pattern: 'John' }), mk({ id: 'b', pattern: 'zzz' })], { text: 'John 3:16', cleared: false }).E1 === true);
    ok('two show-rules: the SECOND matching is enough',
       R([mk({ id: 'a', pattern: 'zzz' }), mk({ id: 'b', pattern: 'John' })], { text: 'John 3:16', cleared: false }).E1 === true);
    ok('a matched HIDE beats a matched SHOW (off air is the safe way to be wrong)',
       R([mk({ id: 'a', pattern: 'John' }), mk({ id: 'b', pattern: 'John', act: 'hide' })], { text: 'John 3:16', cleared: false }).E1 === false);
    /* ---- routing by ProPresenter GROUP / slide LABEL ----
       The operator files a slide under a label in ProPresenter ("Top Lower 3rds") and the
       engine puts the verse in the matching element. Verified against a real PP 21.2 deck:
       four labelled slides each lit exactly one of four positioned scripture elements.
       Slides 2 and 3 of that deck carry IDENTICAL text and different labels, which is why
       label/group are part of the poller's change key — without that the second one is
       skipped as a duplicate and the verse never moves. */
    const byLabel=(pattern,target)=>({id:'L'+pattern,enabled:true,on:'label',match:'contains',pattern,act:'show',target:target||'E1'});
    ok('on=label: a matching slide label shows its element',
       R([byLabel('Top Lower 3rds')],{text:'anything',label:'Top Lower 3rds',cleared:false}).E1===true);
    ok('on=label: a different label leaves it off',
       R([byLabel('Top Lower 3rds')],{text:'anything',label:'Bot Lower 3rds',cleared:false}).E1===false);
    ok('on=label: matching is case-insensitive like the other sources',
       R([byLabel('top lower 3rds')],{text:'',label:'TOP LOWER 3RDS',cleared:false}).E1===true);
    ok('on=label: an unlabelled slide matches nothing',
       R([byLabel('Top Lower 3rds')],{text:'anything',label:'',cleared:false}).E1===false);
    ok('on=group: matches the ProPresenter group name',
       R([{id:'G1',enabled:true,on:'group',match:'contains',pattern:'John 1:1-3',act:'show',target:'E1'}],
         {text:'x',group:'John 1:1-3',cleared:false}).E1===true);
    ok('on=label does NOT accidentally read the slide text',
       R([byLabel('Welcome')],{text:'Welcome home',label:'Bot Lower 3rds',cleared:false}).E1===false);
    ok('on=group does NOT accidentally read the slide text',
       R([{id:'G2',enabled:true,on:'group',match:'contains',pattern:'Welcome',act:'show',target:'E1'}],
         {text:'Welcome home',group:'John 1:1-3',cleared:false}).E1===false);
    // two positions, one live slide: only the labelled one lights
    {
      const rr=R([byLabel('Top Lower 3rds','TOP'),byLabel('Bot Lower 3rds','BOT')],
                 {text:'John 1:1',label:'Bot Lower 3rds',cleared:false});
      ok('two labelled positions: only the matching one is shown', rr.BOT===true && rr.TOP===false);
    }

    ok('two hide-rules, neither matching -> still released',
       R([mk({ id: 'a', pattern: 'x', act: 'hide' }), mk({ id: 'b', pattern: 'y', act: 'hide' })], { text: 'John 3:16', cleared: false }).E1 === true);

    ok('CLEAR releases every target (nothing pinned on air)',
       Object.keys(R(show, { text: 'Welcome', cleared: true })).length === 0);

    const off = [{ id: 'r3', enabled: false, on: 'text', match: 'contains', pattern: 'x', act: 'show', target: 'E1' }];
    ok('a disabled rule has no opinion', R(off, { text: 'x', cleared: false }).E1 === undefined);

    ok('a rule with no target is ignored',
       Object.keys(R([{ id: 'r', enabled: true, match: 'any', act: 'show' }], { text: 'a' })).length === 0);

    // an empty "contains" pattern must not match everything by accident
    const blank = [{ id: 'r4', enabled: true, on: 'text', match: 'contains', pattern: '', act: 'show', target: 'E1' }];
    ok('an empty contains-pattern does not match everything', R(blank, { text: 'anything' }).E1 === false);
  }

  {
    const rx = [{ id: 'r5', enabled: true, on: 'text', match: 'regex', pattern: '^Announcements', act: 'show', target: 'E1' }];
    ok('regex: anchored match', R(rx, { text: 'Announcements today', cleared: false }).E1 === true);
    ok('regex: non-match', R(rx, { text: 'Today announcements', cleared: false }).E1 === false);
    const bad = [{ id: 'r6', enabled: true, on: 'text', match: 'regex', pattern: '[[[unclosed', act: 'show', target: 'E1' }];
    ok('an INVALID regex is treated as no-match instead of throwing',
       R(bad, { text: 'whatever', cleared: false }).E1 === false);
  }

  {
    const byRef = [{ id: 'r7', enabled: true, on: 'ref', match: 'contains', pattern: 'John', act: 'show', target: 'E1' }];
    ok('on=ref matches the reference, not the body',
       R(byRef, { text: 'nothing here', ref: 'John 3:16', cleared: false }).E1 === true);
    ok('on=ref ignores a body-only hit',
       R(byRef, { text: 'John said', ref: 'Psalm 23:1', cleared: false }).E1 === false);
  }

  {
    const any = [{ id: 'r8', enabled: true, match: 'any', act: 'show', target: 'E1' }];
    ok('match=any is always on while there is a live slide', R(any, { text: '', cleared: false }).E1 === true);
    ok('match=any still releases on clear', R(any, { cleared: true }).E1 === undefined);
  }

  {
    const many = [
      { id: 'a', enabled: true, on: 'text', match: 'contains', pattern: 'one', act: 'show', target: 'E1' },
      { id: 'b', enabled: true, on: 'text', match: 'contains', pattern: 'two', act: 'show', target: 'E2' },
    ];
    const m = R(many, { text: 'slide one', cleared: false });
    ok('multiple rules control their own targets independently', m.E1 === true && m.E2 === false);
  }

  ok('nothing threw', errors.length === 0);
  console.log('\nTHEME-RULES RESULT  pass=' + pass + '  fail=' + fail +
              '  ERRORS=' + (errors.length ? errors.slice(0, 3).join(' | ') : 'NONE'));
  process.exit(fail ? 1 : 0);
})();
