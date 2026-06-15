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
    w.Element.prototype.animate=function(){return {cancel(){},finished:Promise.resolve()};};
  }});
const W=dom.window,D=W.document;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const click=(n)=>n&&n.dispatchEvent(new W.MouseEvent('click',{bubbles:true}));
const rows=()=>[...D.querySelectorAll('.elrow')];
const addBtn=(t)=>[...D.querySelectorAll('.addmenu button')].find(b=>b.textContent.trim()==="+ "+t);
const rowByType=(ty)=>rows().find(r=>r.querySelector('.ty')&&r.querySelector('.ty').textContent===ty);
const P=()=>D.getElementById('panels');
const selByLabel=(sub)=>[...P().querySelectorAll('select')].find(s=>{const l=s.parentNode.querySelector('label.fld');return l&&l.textContent.includes(sub);});
const rangeByLabel=(sub)=>[...P().querySelectorAll('input[type=range]')].find(i=>{const d=i.closest('div').parentNode;const l=d&&d.querySelector('label.fld');return l&&l.textContent.includes(sub);});
const swByLabel=(sub)=>{const l=[...P().querySelectorAll('label.sw')].find(x=>x.textContent.includes(sub));return l&&l.querySelector('input');};
const setSel=(s,v)=>{if(!s)return false;s.value=v;s.dispatchEvent(new W.Event('change',{bubbles:true}));return true;};
const setTog=(i,on)=>{if(!i)return;if(i.checked!==on){i.checked=on;i.dispatchEvent(new W.Event('change',{bubbles:true}));}};
const setRange=(i,v)=>{if(!i)return;i.value=String(v);i.dispatchEvent(new W.Event('input',{bubbles:true}));};
const optByText=(sel,sub)=>[...sel.options].find(o=>o.textContent.includes(sub));
// preview renderer roots (creation order; we only add, so the Text we add is last)
const Broot=()=>[...D.querySelectorAll('#pv-scaler .lt-el')].pop();
const selectRow=(ty)=>{click(rowByType(ty).querySelector('.nm'));};
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'PASS':'**FAIL**')+'  '+n);c?pass++:fail++;};
const simV=()=>click(D.getElementById('simV1'));
const simClear=()=>click(D.getElementById('simClear'));

(async()=>{
  await sleep(360);
  click(addBtn('Text')); await sleep(20);     // B = our test element (last .lt-el)
  ok('test Text element added', !!rowByType('text') && !!Broot());

  /* ---------- PERSISTENT (always-on) survives a clear ---------- */
  selectRow('text'); await sleep(10);
  setSel(selByLabel('When to show'),'always'); await sleep(10);
  simV(); await sleep(30);
  const scrVisOn = (()=>{const els=[...D.querySelectorAll('#pv-scaler .lt-el')];return els[0];})(); // scripture root (created first)
  ok('persistent element visible while verse is live', Broot().style.opacity==='1');
  simClear(); await sleep(40);
  ok('persistent element STAYS visible after clear', Broot().style.opacity==='1');
  ok('live scripture element hides on clear', scrVisOn.style.opacity==='0');

  /* ---------- LINKED visibility: shows only with the scripture ---------- */
  selectRow('text'); await sleep(10);
  setSel(selByLabel('When to show'),'linked'); await sleep(15);
  const linkSel=selByLabel('Show together with');
  const scrOpt=linkSel&&optByText(linkSel,'(scripture)');
  ok('link picker lists the scripture', !!scrOpt);
  setSel(linkSel, scrOpt.value); await sleep(10);
  simClear(); await sleep(40);
  ok('linked element hidden when trigger is clear', Broot().style.opacity==='0');
  simV(); await sleep(40);
  ok('linked element appears with the trigger', Broot().style.opacity==='1');

  /* ---------- Z-ORDER layer presets ---------- */
  selectRow('text'); await sleep(10);
  setSel(selByLabel('When to show'),'always'); await sleep(10);
  setSel(selByLabel('Stacking layer'),'10'); await sleep(15);
  ok('layer "On top" sets z-index 10', Broot().style.zIndex==='10');
  setSel(selByLabel('Stacking layer'),'-5'); await sleep(15);
  ok('layer "Behind" sets z-index -5', Broot().style.zIndex==='-5');

  /* ---------- YIELD: drop beneath an overlapping live scripture ---------- */
  setSel(selByLabel('Stacking layer'),'10'); await sleep(10);
  setTog(swByLabel('Yield'),true); await sleep(10);
  simV(); await sleep(40);   // scripture active + overlaps (both at 120,820)
  ok('yield: drops below overlapping scripture (z -1)', Broot().style.zIndex==='-1');
  simClear(); await sleep(40);
  ok('yield: returns to its layer when scripture clears (z 10)', Broot().style.zIndex==='10');
  setTog(swByLabel('Yield'),false); await sleep(10);

  /* ---------- DOCK: reflow to a 2nd position while trigger active, slide home on clear ---------- */
  selectRow('text'); await sleep(10);
  // home X is default 120
  ok('home position is x=120 before docking', Broot().style.left==='120px');
  setTog(swByLabel('Shift to a second position'),true); await sleep(15);
  const trigSel=selByLabel('Triggered by');
  const scrOpt2=trigSel&&optByText(trigSel,'(scripture)');
  ok('dock trigger picker lists the scripture', !!scrOpt2);
  setSel(trigSel, scrOpt2.value); await sleep(10);
  setRange(rangeByLabel('Docked X'),1500); await sleep(10);
  simV(); await sleep(50);
  ok('docks to x=1500 when scripture fires', Broot().style.left==='1500px');
  simClear(); await sleep(50);
  ok('slides back home to x=120 when scripture clears', Broot().style.left==='120px');

  /* ---------- nothing threw the whole time ---------- */
  ok('no runtime errors during layering/dock workflow', errors.length===0);

  console.log('\nLAYERING/DOCK RESULT  pass='+pass+'  fail='+fail+'  ERRORS='+(errors.length?errors.slice(0,5).join(' | '):'NONE'));
  process.exit(fail||errors.length?1:0);
})();
