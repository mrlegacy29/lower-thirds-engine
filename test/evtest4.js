const {JSDOM}=require('jsdom');
const html=require('fs').readFileSync(require('path').join(__dirname,'..','lt.html'),'utf8');
const errors=[];
const dom=new JSDOM(html,{url:'http://localhost:7777/',runScripts:"dangerously",pretendToBeVisual:true,
  beforeParse(w){
    w.ResizeObserver=class{observe(){}};
    w.EventSource=class{constructor(){setTimeout(()=>this.onopen&&this.onopen(),5);}close(){}};
    w.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve({})});
    w.requestAnimationFrame=(c)=>setTimeout(c,0); w.confirm=()=>true; w.prompt=()=>'P';
    w.console.error=(...a)=>errors.push(a.join(' ')); w.onerror=(m)=>errors.push(String(m));
  }});
function run(){
  const D=dom.window.document, W=dom.window;
  const click=(n)=>{ if(!n) throw new Error('element not found'); n.dispatchEvent(new W.MouseEvent('click',{bubbles:true})); };
  const lists=(sid)=>[...D.querySelectorAll('#'+sid+' .lt-el')].filter(e=>e.querySelector('.h-items'))
      .map(e=>[...e.querySelectorAll('.h-items .h-chip .tx')].map(t=>t.textContent));
  const pv=()=>lists('pv-scaler'), pg=()=>lists('pg-scaler');
  const selType=(ty)=>{ const row=[...D.querySelectorAll('.elrow')].find(r=>r.querySelector('.ty')&&r.querySelector('.ty').textContent===ty);
    if(!row) throw new Error('no row of type '+ty); click(row.querySelector('.nm')); };
  const out=[];

  out.push(['boot: no ghost verses', pv().flat().length===0]);
  click(D.getElementById('simV1'));
  out.push(['sample verse does NOT log', pv().flat().length===0]);

  selType('history');
  click([...D.querySelectorAll('.secbody button')].find(b=>/Add test verse/.test(b.textContent)));
  out.push(['Add test verse -> preview list 1', pv().flat().length===1]);
  out.push(['Add test verse -> program list 1 (shared)', pg().flat().length===1]);
  out.push(['preview list === program list', JSON.stringify(pv())===JSON.stringify(pg())]);

  const addEvent=[...D.querySelectorAll('.addmenu .btn')].find(b=>/\+ Event list/.test(b.textContent));
  out.push(['"Event list" in add menu', !!addEvent]);
  click(addEvent);
  out.push(['manual Event list renders items', ['Welcome','Worship','Message'].every(x=>pv().flat().includes(x))]);

  selType('eventList');
  const area=[...D.querySelectorAll('.secbody textarea')][0];
  area.value=area.value+'\nOffering'; area.dispatchEvent(new W.Event('input',{bubbles:true}));
  out.push(['editing manual list adds line', pv().flat().includes('Offering')]);

  const types=[...D.querySelectorAll('.elrow .ty')].map(t=>t.textContent);
  out.push(['both list types coexist', types.includes('history')&&types.includes('eventList')]);

  const tb=D.getElementById('btnTrans');
  click(tb);
  out.push(['take button keeps a valid label after take', /AIR|TAKE|TRANSITION/i.test(tb.querySelector('span').textContent)]);

  out.forEach(([n,ok])=>console.log((ok?'PASS':'**FAIL**')+'  '+n));
  console.log('ERRORS: '+(errors.length?JSON.stringify(errors.slice(0,6)):'none'));
}
setTimeout(()=>{ try{run();}catch(e){console.log('TEST THREW:',e.message);} process.exit(0); },600);
