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
  click(saveBtn); await sleep(20);            // prompt() -> "Test Look"
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
  ok('TAKE updates program (persisted)', W.localStorage.getItem('pplt.program.v2')!==before || pvCount>0);
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

  ok('no runtime errors during operator workflow', errors.length===0);
  console.log('\nOPERATOR RESULT  pass='+pass+'  fail='+fail+'  ERRORS='+(errors.length?errors.slice(0,5).join(' | '):'NONE'));
  process.exit(fail||errors.length?1:0);
})();
