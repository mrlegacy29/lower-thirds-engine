const {JSDOM}=require('jsdom');
const html=require('fs').readFileSync(require('path').join(__dirname,'..','lt.html'),'utf8');
const errors=[];
let slideText="", slideActive=true, layersObj=null;
const dom=new JSDOM(html,{url:'http://localhost:7777/',runScripts:"dangerously",pretendToBeVisual:true,
  beforeParse(w){
    w.ResizeObserver=class{observe(){}};
    w.EventSource=class{constructor(){setTimeout(()=>this.onopen&&this.onopen(),5);}close(){}};
    w.requestAnimationFrame=(c)=>setTimeout(c,0); w.confirm=()=>true; w.prompt=()=>'P';
    w.fetch=(u,o)=>{ const url=String(u);
      if(/layers/.test(url)) return Promise.resolve({ok:true,json:()=>Promise.resolve(layersObj||{slide:slideActive,media:true})});
      if(/slide/.test(url))  return Promise.resolve({ok:true,json:()=>Promise.resolve({current:{text:slideText}})});
      return Promise.resolve({ok:true,json:()=>Promise.resolve({})}); };
    w.console.error=(...a)=>errors.push(a.join(' ')); w.onerror=(m)=>errors.push(String(m));
  }});
const W=dom.window, D=W.document;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const click=(n)=>{ if(!n)throw new Error('not found'); n.dispatchEvent(new W.MouseEvent('click',{bubbles:true})); };
const pgEl=(sel)=>[...D.querySelectorAll('#pg-scaler .lt-el')].find(x=>x.querySelector(sel));
const pgList=()=>{ const e=pgEl('.h-items'); return e?[...e.querySelectorAll('.h-items .h-chip .tx')].map(t=>t.textContent):[]; };
const scriptureHidden=()=>{ const e=pgEl('.r-body'); return !e || e.style.opacity==="0"; };
const scriptureRef=()=>{ const e=pgEl('.r-body'); return e?e.querySelector('.r-ref').textContent:''; };
const selType=(ty)=>{ const row=[...D.querySelectorAll('.elrow')].find(r=>r.querySelector('.ty')&&r.querySelector('.ty').textContent===ty); click(row.querySelector('.nm')); };

(async()=>{
  await sleep(300);
  const out=[];
  const ip=D.querySelector('input[placeholder="192.168.1.100"]'); ip.value='127.0.0.1'; ip.dispatchEvent(new W.Event('input',{bubbles:true}));
  click([...D.querySelectorAll('.secbody button')].find(b=>/Connect/.test(b.textContent)));

  slideText="John 3:16\nFor God so loved the world."; slideActive=true; await sleep(400);
  out.push(['live verse shows on program', /John 3:16/.test(scriptureRef()) && !scriptureHidden()]);
  out.push(['live verse logged', pgList().includes('John 3:16')]);

  slideText="Romans 8:28\nAnd we know."; await sleep(400);
  out.push(['both verses logged', pgList().includes('John 3:16')&&pgList().includes('Romans 8:28')]);

  // exclude ON via checkbox, then Take
  selType('history');
  const tog=[...D.querySelectorAll('.secbody .sw')].find(s=>/only prior verses/i.test(s.textContent));
  const cb=tog.querySelector('input[type=checkbox]'); cb.checked=true; cb.dispatchEvent(new W.Event('change',{bubbles:true}));
  click(D.getElementById('btnTrans'));
  await sleep(450);   // allow out-animation + DOM removal
  out.push(['exclude ON: live verse (Romans) removed from list', !pgList().includes('Romans 8:28')]);
  out.push(['exclude ON: prior verse (John 3:16) remains', pgList().includes('John 3:16')]);

  slideText="Isaiah 40:31\nThey shall mount up."; await sleep(450);
  out.push(['advance: previous verse (Romans) now appears', pgList().includes('Romans 8:28')]);
  out.push(['advance: new live verse (Isaiah) hidden from list', !pgList().includes('Isaiah 40:31')]);
  out.push(['advance: Isaiah shows in scripture box', /Isaiah 40:31/.test(scriptureRef()) && !scriptureHidden()]);

  // ============ CLEAR behavior — the list clears whenever the slide is cleared (any clear) ============
  slideText=""; slideActive=false; layersObj={slide:false,media:true}; await sleep(700);
  out.push(['CLEAR: scripture element hidden (opacity 0)', scriptureHidden()]);
  out.push(['CLEAR empties the ref list', pgList().length===0]);

  // re-populate (exclude-live hides the on-screen verse, the prior remains), then clear again
  slideText="Psalm 23:1\nThe Lord is my shepherd."; slideActive=true; layersObj={slide:true,media:true}; await sleep(400);
  slideText="Acts 2:1\nWhen the day of Pentecost."; await sleep(400);
  out.push(['prior verse shows while a new one is live', pgList().includes('Psalm 23:1') && !pgList().includes('Acts 2:1')]);
  slideText=""; slideActive=false; layersObj={slide:false,media:false}; await sleep(700);
  out.push(['CLEAR empties the list again', pgList().length===0]);

  // ---- toggle OFF: F1 should leave it up (exclude turned off so live verse shows in list) ----
  selType('history');
  const offE=[...D.querySelectorAll('.secbody .sw')].find(s=>/only prior verses/i.test(s.textContent)).querySelector('input[type=checkbox]');
  offE.checked=false; offE.dispatchEvent(new W.Event('change',{bubbles:true}));
  const offC=[...D.querySelectorAll('.secbody .sw')].find(s=>/Clear All \(F1\)/i.test(s.textContent)).querySelector('input[type=checkbox]');
  offC.checked=false; offC.dispatchEvent(new W.Event('change',{bubbles:true}));
  click(D.getElementById('btnTrans'));
  slideText="Acts 2:1\nWhen the day of Pentecost."; slideActive=true; layersObj={slide:true,media:true}; await sleep(400);
  out.push(['toggle OFF setup: live verse in list', pgList().includes('Acts 2:1')]);
  slideText=""; slideActive=false; layersObj={slide:false,media:false}; await sleep(400);
  out.push(['toggle OFF: F1 leaves the ref list UP', pgList().includes('Acts 2:1')]);

  out.forEach(([n,ok])=>console.log((ok?'PASS':'**FAIL**')+'  '+n));
  console.log('ERRORS: '+(errors.length?JSON.stringify(errors.slice(0,6)):'none'));
  process.exit(0);
})().catch(e=>{console.log('THREW:',e.message);process.exit(1);});
