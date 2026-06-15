const {JSDOM}=require('jsdom');
const html=require('fs').readFileSync(require('path').join(__dirname,'..','lt.html'),'utf8');
const errors=[];
let slideText="",slideActive=true;
const dom=new JSDOM(html,{url:'http://localhost:7777/',runScripts:"dangerously",pretendToBeVisual:true,
  beforeParse(w){
    w.ResizeObserver=class{observe(){}};
    w.EventSource=class{constructor(){setTimeout(()=>this.onopen&&this.onopen(),5);}close(){}};
    w.requestAnimationFrame=(c)=>setTimeout(c,0); w.confirm=()=>true; w.prompt=(q,d)=>'Test '+(d||'X'); w.alert=()=>{}; w.URL.createObjectURL=()=>"blob:x"; w.URL.revokeObjectURL=()=>{};
    w.fetch=(u)=>{const url=String(u);
      if(/layers/.test(url))return Promise.resolve({ok:true,json:()=>Promise.resolve({slide:slideActive})});
      if(/slide/.test(url))return Promise.resolve({ok:true,json:()=>Promise.resolve({current:{text:slideText}})});
      return Promise.resolve({ok:true,json:()=>Promise.resolve({})});};
    w.console.error=(...a)=>errors.push('ERR:'+a.join(' ')); w.onerror=(m)=>errors.push('ON:'+String(m));
  }});
const W=dom.window,D=W.document;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const click=(n)=>n&&n.dispatchEvent(new W.MouseEvent('click',{bubbles:true}));
const rows=()=>[...D.querySelectorAll('.elrow')];
const addBtn=(t)=>[...D.querySelectorAll('.addmenu button')].find(b=>b.textContent.trim()==="+ "+t);
const LABELS={scripture:"Scripture",reference:"Reference",name:"Name/title",sermonTitle:"Sermon title",bulletList:"Bullet list",history:"Scripture ref list",eventList:"Event list",text:"Text"};
const rowByType=(ty)=>rows().find(r=>r.querySelector('.ty')&&r.querySelector('.ty').textContent===ty);
const SAFE=/Lower third|Bottom L|Top L|Center|Test animation|Add test verse|Clear log/;
function fireControls(){
  const P=D.getElementById('panels');
  P.querySelectorAll('input[type=range]').forEach(i=>{i.value=parseFloat(i.min||0)+parseFloat(i.step||1);i.dispatchEvent(new W.Event('input',{bubbles:true}));});
  P.querySelectorAll('input[type=color]').forEach(i=>{i.value='#3366cc';i.dispatchEvent(new W.Event('input',{bubbles:true}));});
  P.querySelectorAll('input[type=text]').forEach(i=>{i.value='T'+Math.random().toString(36).slice(2,4);i.dispatchEvent(new W.Event('input',{bubbles:true}));});
  P.querySelectorAll('textarea').forEach(i=>{i.value=(i.value||'')+'\nLine';i.dispatchEvent(new W.Event('input',{bubbles:true}));});
  P.querySelectorAll('select').forEach(s=>{if(s.options.length>1){s.selectedIndex=(s.selectedIndex+1)%s.options.length;s.dispatchEvent(new W.Event('change',{bubbles:true}));}});
  P.querySelectorAll('.sw input[type=checkbox]').forEach(x=>{x.checked=!x.checked;x.dispatchEvent(new W.Event('change',{bubbles:true}));});
  P.querySelectorAll('.seg button').forEach(b=>click(b));
  [...P.querySelectorAll('button')].filter(b=>SAFE.test(b.textContent)).forEach(b=>click(b));
}

(async()=>{
  await sleep(300);
  const TYPES=["scripture","reference","name","sermonTitle","bulletList","history","eventList","text"];
  TYPES.forEach(t=>{ if(!rowByType(t)) click(addBtn(LABELS[t])); });
  await sleep(20);

  // ---- per-element control sweep ----
  let allok=true;
  console.log('per-element control sweep (every input/select/toggle/seg + quick-pos/test-anim):');
  for(const t of TYPES){
    const row=rowByType(t); if(!row){console.log('   **MISSING** '+t);allok=false;continue;}
    const before=errors.length;
    click(row.querySelector('.nm'));   // select -> builds inspector (renderPanels)
    fireControls();                    // applyPreview does NOT rebuild, so DOM stays valid
    await sleep(10);
    const ok=errors.length===before;
    console.log('   '+(ok?'PASS':'**FAIL('+(errors.length-before)+')**')+'  '+t);
    if(!ok)allok=false;
  }

  // ---- structural ops with correct .ic indices (eye0 up1 dn2 del3), re-query each ----
  const s0=errors.length;
  let r=rows(); const n0=r.length;
  click(r[r.length-1].querySelectorAll('.ic')[1]);   // up on last
  r=rows(); click(r[0].querySelectorAll('.ic')[2]);  // down on first
  r=rows(); click(r[2].querySelectorAll('.ic')[3]);  // delete index 2
  const afterStruct=rows().length;
  console.log((errors.length===s0 && afterStruct===n0-1 ? 'PASS':'**FAIL**')+'  reorder up/down + delete (rows '+n0+'->'+afterStruct+')');

  // ---- stale-handler test: capture an up-button, mutate array, click stale button ----
  const st=errors.length;
  r=rows(); const staleUp=r[r.length-1].querySelectorAll('.ic')[1];  // up btn of last row (closure binds its id)
  click(rows()[0].querySelectorAll('.ic')[3]);  // delete first row -> indices shift
  click(rows()[0].querySelectorAll('.ic')[3]);  // delete another
  click(staleUp);                                // fire the now-stale handler
  await sleep(10);
  const sane=rows().length>0;
  console.log((errors.length===st && sane ?'PASS':'**FAIL**')+'  stale reorder handler is a safe no-op (no undefined injected)');

  // ---- connect + live feed + clear ----
  const c0=errors.length;
  const ip=D.querySelector('input[placeholder="192.168.1.100"]'); ip.value='127.0.0.1'; ip.dispatchEvent(new W.Event('input',{bubbles:true}));
  click([...D.querySelectorAll('.secbody button')].find(b=>/Connect/.test(b.textContent)));
  slideText="John 3:16\nFor God so loved."; slideActive=true; await sleep(350);
  slideText=""; slideActive=false; await sleep(300);
  console.log((errors.length===c0?'PASS':'**FAIL**')+'  connect + live verse + clear');

  // ---- url modes / copy / open ----
  const u0=errors.length;
  D.querySelectorAll('#urlMode button').forEach(b=>click(b));
  click(D.getElementById('btnCopyUrl')); click(D.getElementById('btnOpenOut'));
  console.log((errors.length===u0?'PASS':'**FAIL**')+'  url modes / copy / open output');

  // ---- sim buttons + live toggle ----
  const sm=errors.length;
  ['simV1','simV2','simName','simClear','simLive'].forEach(id=>click(D.getElementById(id)));
  console.log((errors.length===sm?'PASS':'**FAIL**')+'  sim verse/name/clear + live toggle');

  // ---- presets: new folder, save, then row icons (rename/overwrite/delete), export ----
  const p0=errors.length;
  click([...D.querySelectorAll('.btn')].find(b=>/New folder/.test(b.textContent)));
  click([...D.querySelectorAll('.btn')].find(b=>/Save preview as preset/.test(b.textContent)));
  [...D.querySelectorAll('.preset .ic')].forEach(b=>click(b));
  click([...D.querySelectorAll('.btn')].find(b=>/Export/.test(b.textContent)));
  console.log((errors.length===p0?'PASS':'**FAIL**')+'  presets: folder/save/overwrite/rename/delete/export');

  // ---- output panel: bg + safe ----
  const o0=errors.length;
  D.querySelectorAll('.secbody .seg.bgpick button, #outBg button').forEach(b=>click(b));
  console.log((errors.length===o0?'PASS':'**FAIL**')+'  output bg / safe-area');

  // ---- transition + revert ----
  const t0=errors.length;
  click(D.getElementById('btnTrans')); await sleep(20); click(D.getElementById('btnRevert'));
  console.log((errors.length===t0?'PASS':'**FAIL**')+'  transition + revert');

  console.log('TOTAL ERRORS: '+(errors.length?JSON.stringify([...new Set(errors)].slice(0,6)):'NONE'));
  process.exit(0);
})().catch(e=>{console.log('THREW:',e.message);process.exit(1);});
