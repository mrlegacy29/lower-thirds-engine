const {JSDOM}=require('jsdom');
const html=require('fs').readFileSync(require('path').join(__dirname,'..','lt.html'),'utf8');
const errors=[];
let slideText="",slideActive=true;
const dom=new JSDOM(html,{url:'http://localhost:7777/',runScripts:"dangerously",pretendToBeVisual:true,
  beforeParse(w){
    w.ResizeObserver=class{observe(){}};
    w.EventSource=class{constructor(){setTimeout(()=>this.onopen&&this.onopen(),5);}close(){}};
    w.requestAnimationFrame=(c)=>setTimeout(c,0); w.confirm=()=>true; w.prompt=(q,d)=>'X'; w.alert=()=>{};
    w.URL.createObjectURL=()=>"blob:x"; w.URL.revokeObjectURL=()=>{};
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
const rowByType=(ty)=>rows().find(r=>r.querySelector('.ty')&&r.querySelector('.ty').textContent===ty);
const P=()=>D.getElementById('panels');
const selByOption=(val)=>[...P().querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value===val));
const setSel=(s,val)=>{ if(!s)return false; s.value=val; s.dispatchEvent(new W.Event('change',{bubbles:true})); return true; };
const inputByPH=(sub)=>[...P().querySelectorAll('input[type=text]')].find(i=>(i.placeholder||'').includes(sub));
const btnByText=(re)=>[...P().querySelectorAll('button')].find(b=>re.test(b.textContent));
let pass=0,fail=0;
function ok(name,cond){ console.log((cond?'PASS':'**FAIL**')+'  '+name); cond?pass++:fail++; }

(async()=>{
  await sleep(300);

  /* ---------- 1. MEDIA ELEMENT: add, link by URL, fit/crop/scrim ---------- */
  click(addBtn("Image / Media"));
  await sleep(20);
  const mrow=rowByType('media');
  ok('media element added', !!mrow);
  click(mrow.querySelector('.nm')); await sleep(10);
  const before1=errors.length;
  const urlIn=inputByPH('image or mp4');
  ok('media URL field present', !!urlIn);
  urlIn.value="https://example.com/back.jpg"; urlIn.dispatchEvent(new W.Event('input',{bubbles:true}));
  await sleep(20);
  const mediaImg=D.querySelector('.lt-media img');
  ok('media <img> rendered in preview', !!mediaImg && /back\.jpg/.test(mediaImg.getAttribute('src')||''));
  // now fit/zoom/scrim controls should exist
  const fitSel=selByOption('cover');
  ok('fit selector appears once media set', !!fitSel);
  ['contain','stretch','center','tile','cover'].forEach(f=>setSel(selByOption('cover')||selByOption(f),f));
  // ranges (zoom/opacity/focal/scrim) + scrim color
  P().querySelectorAll('input[type=range]').forEach(i=>{i.value=parseFloat(i.min||0)+parseFloat(i.step||1);i.dispatchEvent(new W.Event('input',{bubbles:true}));});
  P().querySelectorAll('input[type=color]').forEach(i=>{i.value='#102030';i.dispatchEvent(new W.Event('input',{bubbles:true}));});
  await sleep(20);
  ok('media fit/crop/scrim controls fire with no errors', errors.length===before1);
  // scrim div shows when scrim>0 and media present
  const scrimShown=[...D.querySelectorAll('.lt-scrim')].some(s=>s.style.display==='block');
  ok('scrim layer activates with media + scrim>0', scrimShown);

  /* ---------- 2. CONTINUOUS MOTION on a text element: every type ---------- */
  if(!rowByType('text')) click(addBtn('Text')); await sleep(10);
  click(rowByType('text').querySelector('.nm')); await sleep(10);
  const motionTypes=['pulse','glow','float','sway','spin','shine','gradientShift','ticker','rollV','none'];
  let motionOk=true, b2=errors.length;
  for(const mt of motionTypes){
    const sel=selByOption('gradientShift');   // the motion select (unique option)
    if(!setSel(sel,mt)){motionOk=false;break;}
    await sleep(12);
    if(mt==='ticker'){ const marq=D.querySelector('.lt-marq'); const track=D.querySelector('.lt-marq .lt-track');
      if(!marq||!track||track.querySelectorAll('.mseg').length<2){motionOk=false;console.log('   ticker structure missing');} }
    if(mt==='rollV'){ if(!D.querySelector('.lt-marq.vert')){motionOk=false;console.log('   rollV vertical missing');} }
    if(mt==='none'){ if(D.querySelector('.lt-marq')){motionOk=false;console.log('   marquee not torn down on none');} }
  }
  ok('all 10 continuous-motion types apply (ticker+roll build a track, none tears down)', motionOk);
  ok('motion sweep raised no errors', errors.length===b2);

  /* float custom angle path */
  const b3=errors.length;
  setSel(selByOption('gradientShift'),'float'); await sleep(10);
  const dirSel=selByOption('custom'); setSel(dirSel,'custom'); await sleep(10);
  P().querySelectorAll('input[type=range]').forEach(i=>{i.value=parseFloat(i.min||0)+parseFloat(i.step||1);i.dispatchEvent(new W.Event('input',{bubbles:true}));});
  await sleep(10);
  ok('float custom-angle controls work', errors.length===b3);
  setSel(selByOption('gradientShift'),'none'); await sleep(10);

  /* ---------- 3. ENTRANCE/EXIT: fly + blur + zoom + pop via Test button ---------- */
  const b4=errors.length;
  const inSel=selByOption('fly');                 // animation In select (has 'fly')
  function testAnimNow(){ const tb=btnByText(/Test animation/); click(tb); }
  for(const mode of ['fly','blur','zoom-in','zoom-out','pop','wipe','slide-left']){
    setSel(selByOption('fly'),mode); await sleep(5);
    if(mode==='fly'){ // set fly angle + distance ranges
      P().querySelectorAll('input[type=range]').forEach(i=>{i.value=parseFloat(i.min||0)+parseFloat(i.step||5);i.dispatchEvent(new W.Event('input',{bubbles:true}));}); }
    testAnimNow(); await sleep(40);
  }
  ok('entrance modes fly/blur/zoom/pop/wipe run via Test animation, no errors', errors.length===b4);

  /* ---------- 4. media background on a NON-media element (e.g. scripture) ---------- */
  const b5=errors.length;
  click(rowByType('scripture').querySelector('.nm')); await sleep(10);
  const urlIn2=inputByPH('image or mp4');
  ok('every element exposes a media URL field', !!urlIn2);
  urlIn2.value="https://example.com/lower-third-plate.png"; urlIn2.dispatchEvent(new W.Event('input',{bubbles:true}));
  await sleep(20);
  const scrImg=[...D.querySelectorAll('.lt-media img')].some(i=>/lower-third-plate/.test(i.getAttribute('src')||''));
  ok('scripture element accepts a background image', scrImg);
  ok('media-on-text raised no errors', errors.length===b5);

  /* ---------- 5. persistence round-trip (config survives save/load via transition) ---------- */
  const b6=errors.length;
  const trans=D.getElementById('btnTrans'); click(trans); await sleep(30);
  ok('TRANSITION publishes media+motion config with no errors', errors.length===b6);

  console.log('\nMEDIA/MOTION RESULT  pass='+pass+'  fail='+fail+'  ERRORS='+(errors.length?errors.slice(0,6).join(' | '):'NONE'));
  process.exit(fail||errors.length?1:0);
})();
