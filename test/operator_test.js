const {JSDOM}=require('jsdom');
const html=require('fs').readFileSync(require('path').join(__dirname,'..','lt.html'),'utf8');
const errors=[];
let slideText="",slideActive=true;
const dom=new JSDOM(html,{url:'http://localhost:7777/',runScripts:"dangerously",pretendToBeVisual:true,
  beforeParse(w){
    w.ResizeObserver=class{observe(){}};
    w.EventSource=class{constructor(){setTimeout(()=>this.onopen&&this.onopen(),5);}close(){}};
    w.requestAnimationFrame=(c)=>setTimeout(c,0); w.confirm=()=>true; w.prompt=()=>"Test Look"; w.alert=()=>{};
    w.fetch=(u)=>{const url=String(u);
      if(/layers/.test(url))return Promise.resolve({ok:true,json:()=>Promise.resolve({slide:slideActive})});
      if(/slide/.test(url))return Promise.resolve({ok:true,json:()=>Promise.resolve({current:{text:slideText}})});
      return Promise.resolve({ok:true,json:()=>Promise.resolve({})});};
    w.console.error=(...a)=>errors.push('ERR:'+a.join(' '));
    w.Element.prototype.animate=function(){return {cancel(){},finished:Promise.resolve()};};
  }});
const W=dom.window,D=W.document;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const click=(n)=>n&&n.dispatchEvent(new W.MouseEvent('click',{bubbles:true}));
const root=()=>D.getElementById('console-root');
const vbtn=(v)=>[...D.querySelectorAll('#viewSwitch button')].find(b=>b.dataset.view===v);
const tiles=()=>[...D.querySelectorAll('#opLookGrid .ol-tile')];
const tileByName=(nm)=>tiles().find(t=>t.querySelector('.t-name')&&t.querySelector('.t-name').textContent===nm);
const btnByText=(re)=>[...D.querySelectorAll('#panels button')].find(b=>re.test(b.textContent));
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'PASS':'**FAIL**')+'  '+n);c?pass++:fail++;};

(async()=>{
  await sleep(360);

  /* ---- view switching toggles the right classes ---- */
  click(vbtn('showcaller')); await sleep(20);
  ok('Showcaller adds op + skin-showcaller', root().classList.contains('op')&&root().classList.contains('skin-showcaller'));
  click(vbtn('simple')); await sleep(20);
  ok('Simple swaps to skin-simple (not showcaller)', root().classList.contains('skin-simple')&&!root().classList.contains('skin-showcaller'));
  click(vbtn('builder')); await sleep(20);
  ok('Builder removes all operator classes', !root().classList.contains('op')&&!root().classList.contains('skin-simple'));

  /* ---- empty state + persistent Blank tile ---- */
  click(vbtn('showcaller')); await sleep(20);
  ok('Blank/Clear tile always present', !!tileByName('Blank / Clear'));
  ok('empty-state hint shows when no saved looks', !!D.querySelector('#opLookGrid .ol-empty'));

  /* ---- save a look in Builder, see it as a tile in Operator ---- */
  click(vbtn('builder')); await sleep(10);
  const saveBtn=btnByText(/Save preview as preset/);
  ok('found "Save preview as preset" button', !!saveBtn);
  click(saveBtn); await sleep(20);
  // in-page naming dialog (Electron has no window.prompt)
  {
    const ask=D.querySelector('.lt-ask');
    ok('naming dialog opened', !!ask);
    if(ask){ const i=ask.querySelector('input');
      if(i){ i.value='Test Look'; i.dispatchEvent(new W.Event('input',{bubbles:true})); }
      const okb=ask.querySelector('[data-ask="ok"]'); if(okb)click(okb); }
  }
  await sleep(30);
  click(vbtn('showcaller')); await sleep(20);
  ok('saved look appears as a tile in Operator', !!tileByName('Test Look'));

  /* ---- tapping a look loads it into Preview (tile selected) ---- */
  const b0=errors.length;
  click(tileByName('Test Look')); await sleep(20);
  ok('tapped look becomes selected', tileByName('Test Look').classList.contains('sel'));
  const pvCount=D.querySelectorAll('#pv-scaler .lt-el').length;
  ok('preview shows the look\'s elements', pvCount>0);

  /* ---- TAKE sends preview to program ---- */
  const before=W.localStorage.getItem('pplt.program.v2');
  click(D.getElementById('btnTrans')); await sleep(20);
  // `|| pvCount>0` used to be here, but pvCount>0 is ASSERTED TRUE five lines above, so the
  // whole condition was unconditionally true. This is the only assertion in the repo covering
  // TAKE persistence — and if the program is never written to localStorage, an OBS browser
  // source that reloads after a TAKE boots to the PREVIOUS look (lt.html reads LS_PROGRAM at
  // startup). That is lost-graphics-on-air, so it has to be able to fail.
  ok('TAKE updates program (persisted)', W.localStorage.getItem('pplt.program.v2')!==before);
  ok('no errors loading/taking a look', errors.length===b0);

  /* ---- Blank tile clears the screen ---- */
  click(tileByName('Blank / Clear')); await sleep(20);
  ok('Blank tile empties the preview', D.querySelectorAll('#pv-scaler .lt-el').length===0);
  ok('Blank tile is marked selected', tileByName('Blank / Clear').classList.contains('sel'));

  /* ---- ON AIR status reflects the live PROGRAM slide (real PP feed) ---- */
  const ip=D.querySelector('input[placeholder="192.168.1.100"]');
  ip.value='127.0.0.1'; ip.dispatchEvent(new W.Event('input',{bubbles:true}));
  click([...D.querySelectorAll('#panels button')].find(b=>/Connect/.test(b.textContent)));
  slideText="John 3:16"; slideActive=true; await sleep(420);
  const air=D.getElementById('opAir');
  ok('ON AIR lights when a verse is live on program', air.classList.contains('live') && D.getElementById('opAirTxt').textContent==='ON AIR');
  ok('slide text mirrored into operator status', /John 3:16/.test(D.getElementById('opSlideTxt').textContent||''));
  slideText=""; slideActive=false; await sleep(420);
  ok('returns to STANDBY on clear', !air.classList.contains('live') && D.getElementById('opAirTxt').textContent==='STANDBY');

  /* ---- clock is ticking ---- */
  ok('clock renders HH:MM:SS', /^\d\d:\d\d:\d\d$/.test(D.getElementById('opClock').textContent||''));

  /* ---------- the Preview-feed sample buttons must actually DO something ----------
     Reported from the app: "I used the sample names and clear button and it didn't do
     anything." Both were real:
       - SAMPLEN carried only body/rawText, but a Name element reads data.name/data.title
         (nameFor/titleFor), so "Sample name" fed data nothing could render — dead button.
       - SAMPLE1 was John 3:16, which is ALSO the Scripture element's factory placeholder,
         so on a fresh look "Sample verse" replaced the text with itself.
     final_check2 already clicked all five of these, but only asserted nothing THREW —
     "clicked without an error" is not "did something". These assert the effect. */
  {
    const pvTxt = () => [...D.querySelectorAll('#pv-scaler .lt-el')]
      .filter(e => e.style.opacity !== '0').map(e => e.textContent).join(' ');

    // The Blank tile was loaded above ("Blank tile empties the preview"), so there is
    // nothing on stage to render into. Put a real look back first, or these assert against
    // an intentionally empty preview and fail for the wrong reason.
    click(tileByName('Test Look')); await sleep(60);
    ok('a look is loaded before the sample-feed checks',
       D.querySelectorAll('#pv-scaler .lt-el').length > 0);

    click(D.getElementById('simV1')); await sleep(60);
    ok('Sample verse visibly changes the preview', /Psalm 23:1/.test(pvTxt()));
    ok('...and is NOT the factory placeholder verse', !/John 3:16/.test(pvTxt()));

    click(D.getElementById('simV2')); await sleep(60);
    ok('Verse 2 swaps the live verse', /Romans 8:28/.test(pvTxt()));

    click(D.getElementById('simClear')); await sleep(60);
    ok('Clear removes the live verse', !/Romans 8:28/.test(pvTxt()));

    // No Name element in this look, so the button must say so rather than sit silent.
    click(D.getElementById('simName')); await sleep(40);
    ok('Sample name reports when no Name element can show it',
       /Add a Name element/i.test(D.getElementById('simName').textContent || ''));
    await sleep(1400);   // let flash() restore the label before later assertions

    // ...and with a Name element present it must actually RENDER the sample. Asserting on
    // "Pastor Mike Reynolds" would be worthless here — that is the element's own factory
    // placeholder, so it shows up whether or not the sample data works. SAMPLEN uses a
    // distinct name precisely so this assertion can tell the difference.
    // Adding a layer is a BUILDER action — this suite has been driving the operator view,
    // where the Layers panel is not the surface being rendered. Switch back first, or the
    // element is added to a preview nothing is showing.
    const vs = D.getElementById('viewSwitch');
    const bBtn = vs && [...vs.querySelectorAll('button')].find(b => b.dataset.view === 'builder');
    if (bBtn) { click(bBtn); await sleep(150); }
    ok('switched to builder view for the layer test',
       !D.getElementById('console-root').classList.contains('op'));

    const addName = [...D.querySelectorAll('button')].find(b => /name\s*\/\s*title/i.test(b.textContent));
    ok('builder offers a Name/title element', !!addName);
    if (addName) {
      click(addName); await sleep(150);

      // A new element defaults to source=manual, and a manual element IGNORES live data by
      // design (manualContent returns its own content). So the button correctly declines
      // here — assert that, then flip it to Live and assert the sample actually lands.
      click(D.getElementById('simName')); await sleep(40);
      ok('Sample name says the Name element is on Manual',
         /Set Name source to Live/i.test(D.getElementById('simName').textContent || ''));
      await sleep(1400);

      const liveSeg = [...D.querySelectorAll('button')]
        .find(b => /^Live\b/i.test((b.textContent || '').trim()) && !/ProPresenter feed/i.test(b.textContent));
      ok('the Name element has a Live source option', !!liveSeg);
      if (liveSeg) {
        click(liveSeg); await sleep(150);
        click(D.getElementById('simName')); await sleep(150);
        // Scope to the Name element's OWN nodes. Matching against the whole preview would
        // also match SAMPLEN.body, which carries the same words — the assertion would then
        // pass even with name/title stripped, i.e. with the original bug still present.
        const nm = D.querySelector('#pv-scaler .n-name');
        const ti = D.querySelector('#pv-scaler .n-title');
        ok('Sample name renders into the LIVE Name element itself',
           !!nm && /Dr\. Sarah Whitfield/.test(nm.textContent || ''));
        ok('...including the role title', !!ti && /Guest Speaker/.test(ti.textContent || ''));
        await sleep(1400);
      }
    }
  }

  ok('no runtime errors during operator workflow', errors.length===0);
  console.log('\nOPERATOR RESULT  pass='+pass+'  fail='+fail+'  ERRORS='+(errors.length?errors.slice(0,5).join(' | '):'NONE'));
  process.exit(fail||errors.length?1:0);
})();
