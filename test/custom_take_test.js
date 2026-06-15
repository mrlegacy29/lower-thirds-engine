const {JSDOM}=require('jsdom');
const html=require('fs').readFileSync(require('path').join(__dirname,'..','lt.html'),'utf8');
const errors=[];
const dom=new JSDOM(html,{url:'http://localhost:7777/',runScripts:"dangerously",pretendToBeVisual:true,
  beforeParse(w){
    w.ResizeObserver=class{observe(){}};
    w.EventSource=class{constructor(){setTimeout(()=>this.onopen&&this.onopen(),5);}close(){}};
    w.requestAnimationFrame=(c)=>setTimeout(c,0); w.confirm=()=>true; w.prompt=()=>"X"; w.alert=()=>{};
    w.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve({})});
    w.console.error=(...a)=>errors.push('ERR:'+a.join(' '));
    w.__anim=[];
    w.Element.prototype.animate=function(frames,opts){ w.__anim.push({el:this,frames,opts}); return {cancel(){},finished:Promise.resolve()}; };
  }});
const W=dom.window,D=W.document;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const click=(n)=>n&&n.dispatchEvent(new W.MouseEvent('click',{bubbles:true}));
const rows=()=>[...D.querySelectorAll('.elrow')];
const addBtn=(t)=>[...D.querySelectorAll('.addmenu button')].find(b=>b.textContent.trim()==="+ "+t);
const rowByType=(ty)=>rows().find(r=>r.querySelector('.ty')&&r.querySelector('.ty').textContent===ty);
const P=()=>D.getElementById('panels');
const selByOpt=(v)=>[...P().querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value===v));
const selByLabel=(sub)=>[...P().querySelectorAll('select')].find(s=>{const l=s.parentNode.querySelector('label.fld');return l&&l.textContent.includes(sub);});
const rangeByLabel=(sub)=>[...P().querySelectorAll('input[type=range]')].find(i=>{const d=i.closest('div').parentNode;const l=d&&d.querySelector('label.fld');return l&&l.textContent.includes(sub);});
const colorByLabel=(sub)=>{ const labs=[...P().querySelectorAll('label.fld')].filter(l=>l.textContent.trim()===sub);
  const lab=labs[labs.length-1]; return lab?lab.parentNode.querySelector('input[type=color]'):null; };
const swByLabel=(sub)=>{const l=[...P().querySelectorAll('label.sw')].find(x=>x.textContent.includes(sub));return l&&l.querySelector('input');};
const setSel=(s,v)=>{if(!s)return false;s.value=v;s.dispatchEvent(new W.Event('change',{bubbles:true}));return true;};
const setTog=(i,on)=>{if(!i)return;if(i.checked!==on){i.checked=on;i.dispatchEvent(new W.Event('change',{bubbles:true}));}};
const setRange=(i,v)=>{if(!i)return;i.value=String(v);i.dispatchEvent(new W.Event('input',{bubbles:true}));};
const setColor=(i,v)=>{if(!i)return;i.value=v;i.dispatchEvent(new W.Event('input',{bubbles:true}));};
const Broot=()=>[...D.querySelectorAll('#pv-scaler .lt-el')].pop();
const Bbox=()=>Broot()&&Broot().querySelector('.lt-box');
const selectRow=(ty)=>click(rowByType(ty).querySelector('.nm'));
const drain=()=>{const a=W.__anim;W.__anim=[];return a;};
const fr=(r)=>JSON.stringify(r.frames);
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'PASS':'**FAIL**')+'  '+n);c?pass++:fail++;};

(async()=>{
  await sleep(360);
  const trans=D.getElementById('btnTrans'), pg=D.getElementById('pgMon');

  /* ---------- TAKE STATE / pending vs live ---------- */
  ok('starts synced (Program matches Preview)', trans.classList.contains('synced') && /ON AIR/.test(trans.querySelector('span').textContent));
  click(addBtn('Text')); await sleep(20);        // adds an element -> preview now differs from program
  ok('editing Preview flips TAKE to pending', trans.classList.contains('pending') && /TAKE TO AIR/.test(trans.querySelector('span').textContent));
  ok('Program panel shows "not yet taken" cue', pg.classList.contains('pending-diff'));
  const beforeTake=W.localStorage.getItem('pplt.program.v2');
  click(trans); await sleep(20);
  ok('after TAKE it is synced again', trans.classList.contains('synced') && !pg.classList.contains('pending-diff'));
  const prog=JSON.parse(W.localStorage.getItem('pplt.program.v2'));
  ok('TAKE stamps a _take nonce (signals OBS to replay)', !!prog._take && W.localStorage.getItem('pplt.program.v2')!==beforeTake);

  /* ---------- TAKE replays the entrance (so anim changes are visible) ---------- */
  selectRow('text'); await sleep(10);
  setSel(selByLabel('In'),'pop'); await sleep(10);   // change entrance anim
  // re-take and confirm replay path runs without error (visual replay is WAAPI-free transition)
  const e0=errors.length; click(trans); await sleep(20);
  ok('changing entrance + TAKE runs cleanly (replay fires)', errors.length===e0);

  /* ---------- GLOW color modes (verify real keyframes) ---------- */
  selectRow('text'); await sleep(10);
  setSel(selByOpt('gradientShift'),'glow'); await sleep(15); drain();
  // rainbow
  setSel(selByLabel('Glow color'),'rainbow'); await sleep(15);
  ok('glow → rainbow emits multi-hue hsl shadows', drain().some(r=>/hsl\(/.test(fr(r)) && (fr(r).match(/hsl\(/g)||[]).length>=4));
  // single custom color
  setSel(selByLabel('Glow color'),'single'); await sleep(10);
  setColor(colorByLabel('Color'),'#ff0000'); await sleep(15);
  ok('glow → single uses the chosen color', drain().some(r=>/#ff0000/i.test(fr(r))));
  // dual
  setSel(selByLabel('Glow color'),'dual'); await sleep(10);
  setColor(colorByLabel('Color A'),'#112233'); setColor(colorByLabel('Color B'),'#445566'); await sleep(15);
  ok('glow → dual cycles between both colors', drain().some(r=>/#112233/i.test(fr(r))&&/#445566/i.test(fr(r))));
  // size
  setRange(rangeByLabel('Glow size'),40); await sleep(15);
  ok('glow size feeds the blur radius', drain().some(r=>/40px/.test(fr(r))));

  /* ---------- BEVEL + SHAPE ---------- */
  setSel(selByOpt('gradientShift')||selByLabel('Continuous motion'),'none'); await sleep(10);
  setTog(swByLabel('Bevel'),true); await sleep(15);
  ok('bevel adds an inset 3D edge to the box shadow', /inset/.test(Bbox().style.boxShadow||''));
  setSel(selByLabel('Shape'),'pill'); await sleep(15);
  ok('shape "pill" gives a full border-radius', (Bbox().style.borderRadius||'')==='999px');
  setSel(selByLabel('Shape'),'parallelogram'); await sleep(15);
  ok('shape "parallelogram" applies a clip-path polygon', /polygon/.test(Bbox().style.clipPath||''));
  setSel(selByLabel('Shape'),'cut'); await sleep(15);
  ok('shape "cut corners" applies a clip-path', /polygon/.test(Bbox().style.clipPath||''));
  setSel(selByLabel('Shape'),'rect'); await sleep(15);
  ok('shape "rectangle" clears the clip-path', (Bbox().style.clipPath||'none')==='none');

  ok('no runtime errors across the whole workflow', errors.length===0);
  console.log('\nCUSTOM/TAKE RESULT  pass='+pass+'  fail='+fail+'  ERRORS='+(errors.length?errors.slice(0,5).join(' | '):'NONE'));
  process.exit(fail||errors.length?1:0);
})();
