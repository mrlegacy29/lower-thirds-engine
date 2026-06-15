const {JSDOM}=require('jsdom');
const html=require('fs').readFileSync(require('path').join(__dirname,'..','lt.html'),'utf8');
const errors=[];
const dom=new JSDOM(html,{url:'http://localhost:7777/',runScripts:"dangerously",pretendToBeVisual:true,
  beforeParse(w){
    w.ResizeObserver=class{observe(){}};
    w.EventSource=class{constructor(){setTimeout(()=>this.onopen&&this.onopen(),5);}close(){}};
    w.requestAnimationFrame=(c)=>setTimeout(c,0); w.confirm=()=>true; w.alert=()=>{};
    w.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve({})});
    w.console.error=(...a)=>errors.push('ERR:'+a.join(' '));
    // Record every WAAPI animation the engine starts
    w.__anim=[];
    w.Element.prototype.animate=function(frames,opts){ w.__anim.push({el:this,frames,opts}); return {cancel(){},finished:Promise.resolve(),pause(){},play(){}}; };
  }});
const W=dom.window,D=W.document;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const click=(n)=>n&&n.dispatchEvent(new W.MouseEvent('click',{bubbles:true}));
const rows=()=>[...D.querySelectorAll('.elrow')];
const addBtn=(t)=>[...D.querySelectorAll('.addmenu button')].find(b=>b.textContent.trim()==="+ "+t);
const rowByType=(ty)=>rows().find(r=>r.querySelector('.ty')&&r.querySelector('.ty').textContent===ty);
const P=()=>D.getElementById('panels');
const motionSel=()=>[...P().querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='gradientShift'));
const setSel=(s,v)=>{s.value=v;s.dispatchEvent(new W.Event('change',{bubbles:true}));};
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'PASS':'**FAIL**')+'  '+n);c?pass++:fail++;};
const recent=()=>{const a=W.__anim;W.__anim=[];return a;};   // drain
const has=(arr,pred)=>arr.some(pred);
const fr=(rec)=>JSON.stringify(rec.frames);

(async()=>{
  await sleep(300);
  if(!rowByType('text')) click(addBtn('Text')); await sleep(10);
  click(rowByType('text').querySelector('.nm')); await sleep(10);
  recent();

  setSel(motionSel(),'pulse'); await sleep(15);
  ok('pulse → scale keyframes on box', has(recent(),r=>/scale\(/.test(fr(r))&&r.el.classList.contains('lt-box')));

  setSel(motionSel(),'spin'); await sleep(15);
  ok('spin → rotate(360deg) linear infinite', has(recent(),r=>/rotate\(360deg\)/.test(fr(r))&&r.opts&&r.opts.iterations===Infinity));

  setSel(motionSel(),'glow'); await sleep(15);
  ok('glow → boxShadow keyframes', has(recent(),r=>/boxShadow/.test(fr(r))));

  setSel(motionSel(),'shine'); await sleep(15);
  { const a=recent(); ok('shine → gleam sweep (translateX)', has(a,r=>/translateX\(-130%\)/.test(fr(r))&&r.el.classList.contains('gleam'))); }

  let gbox=null;
  setSel(motionSel(),'gradientShift'); await sleep(15);
  { const a=recent();
    ok('gradientShift → backgroundPosition keyframes', has(a,r=>/backgroundPosition/.test(fr(r))));
    gbox=(a.find(r=>/backgroundPosition/.test(fr(r)))||{}).el;
    ok('gradientShift sets background-size > 100%', !!gbox && /220%/.test(gbox.style.backgroundSize||'')); }

  setSel(motionSel(),'float'); await sleep(15);
  ok('float → translate keyframes', has(recent(),r=>/translate\(/.test(fr(r))));

  setSel(motionSel(),'ticker'); await sleep(20);
  { const a=recent();
    ok('ticker → translateX loop on a .lt-track', has(a,r=>/translateX/.test(fr(r))&&r.el.classList.contains('lt-track')));
    ok('ticker is infinite + linear', has(a,r=>r.el.classList&&r.el.classList.contains('lt-track')&&r.opts.iterations===Infinity&&r.opts.easing==='linear')); }

  setSel(motionSel(),'rollV'); await sleep(20);
  ok('credits roll → translateY on a vertical track', has(recent(),r=>/translateY/.test(fr(r))&&r.el.classList.contains('lt-track')));

  // turning motion off cancels (box transform + background-size cleared on the SAME box)
  setSel(motionSel(),'none'); await sleep(15);
  ok('motion → none clears box transform + bg-size', !!gbox && (gbox.style.transform||'')==='' && (gbox.style.backgroundSize||'')==='');

  console.log('\nWAAPI RESULT  pass='+pass+'  fail='+fail+'  ERRORS='+(errors.length?errors.slice(0,5).join(' | '):'NONE'));
  process.exit(fail||errors.length?1:0);
})();
