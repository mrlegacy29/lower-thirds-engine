const {JSDOM}=require('jsdom');
const html=require('fs').readFileSync(require('path').join(__dirname,'..','lt.html'),'utf8');
const errors=[];
const dom=new JSDOM(html,{url:'http://localhost:7777/',runScripts:"dangerously",pretendToBeVisual:true,
  beforeParse(w){
    w.ResizeObserver=class{observe(){}disconnect(){}unobserve(){}};
    w.EventSource=class{constructor(){this.onmessage=this.onopen=this.onerror=null;setTimeout(()=>this.onopen&&this.onopen(),5);}close(){}};
    w.fetch=(u,o)=>Promise.resolve({ok:true,json:()=>Promise.resolve({})});
    w.requestAnimationFrame=(c)=>setTimeout(c,0);
    w.confirm=()=>true; w.prompt=(q,d)=>'X'+Math.random().toString(36).slice(2,5);
    w.console.error=(...a)=>errors.push(a.join(' '));
    w.onerror=(m)=>errors.push('onerror: '+m);
  }});
const W=dom.window, D=W.document;
function click(n){n.dispatchEvent(new W.MouseEvent('click',{bubbles:true}));}
function setVal(n,v,type){ n.value=v; n.dispatchEvent(new W.Event(type||'input',{bubbles:true})); }
function txt(){return D.body.textContent;}
function findBtn(re){return [...D.querySelectorAll('button')].find(b=>re.test(b.textContent));}

setTimeout(async()=>{
  const out=[];
  // ---- boot: scripture must be visible on the preview canvas now ----
  const pvEls=D.getElementById('pv-scaler').querySelectorAll('.lt-el');
  // Tracks SAMPLE1, which the console auto-loads into the preview on boot. It used to be
  // John 3:16 — the SAME text as the Scripture element's factory placeholder — so this
  // assertion could not tell "the sample loaded" from "the placeholder is showing".
  // SAMPLE1 is now a different verse, which makes this check mean something.
  const scrVisible=[...pvEls].some(e=>/The Lord is my shepherd/.test(e.textContent));
  out.push(['boot: scripture sample visible on canvas', scrVisible]);
  out.push(['boot: live-feed button defaults OFF', /OFF/.test(D.getElementById('simLive').textContent)]);

  // ---- preset icon buttons are real SVG icons, not empty boxes ----
  const presetIcons=D.querySelectorAll('.folder .fh .ic svg, .folder .fh .ic');
  const folderBtns=D.querySelectorAll('.folder .fh .ic');
  const allHaveSvg=[...folderBtns].every(b=>b.querySelector('svg'));
  out.push(['preset/folder buttons render SVG (no white boxes)', folderBtns.length>0 && allHaveSvg]);
  const layerBtns=D.querySelectorAll('.elrow .ic');
  out.push(['layer row buttons render SVG', layerBtns.length>0 && [...layerBtns].every(b=>b.querySelector('svg'))]);

  // ---- transition button present + centered bar ----
  out.push(['transition button exists above canvases', !!D.getElementById('btnTrans')]);
  out.push(['no old left-panel Take button', !D.getElementById('btnTake')]);

  // ---- exercise EVERY control type on the scripture inspector ----
  const scrNm=[...D.querySelectorAll('.elrow .nm')].find(n=>/Scripture/.test(n.textContent));
  click(scrNm);
  const beforeErr=errors.length;
  // range: a size slider
  const range=D.querySelector('.secbody input[type=range]'); setVal(range, range.value? (parseFloat(range.value)+3):40);
  // color: a color field
  const color=D.querySelector('.secbody input[type=color]'); setVal(color, '#123456');
  const colorText=color.parentElement.querySelector('input[type=text]'); setVal(colorText,'#abcdef');
  // select: font or weight
  const select=D.querySelector('.secbody select'); if(select){ select.value=select.options[1].value; select.dispatchEvent(new W.Event('change',{bubbles:true})); }
  // toggle (switch)
  const toggle=D.querySelector('.secbody .sw input[type=checkbox]'); if(toggle){ toggle.checked=!toggle.checked; toggle.dispatchEvent(new W.Event('change',{bubbles:true})); }
  // segmented
  const seg=D.querySelector('.secbody .seg button'); if(seg) click(seg);
  out.push(['scripture inspector controls fire with no errors', errors.length===beforeErr]);

  // switch scripture source to manual -> textarea appears -> edit it
  const srcSeg=[...D.querySelectorAll('.secbody .seg button')].find(b=>/Manual text/.test(b.textContent));
  if(srcSeg){ click(srcSeg);
    const area=D.querySelector('.secbody textarea'); 
    out.push(['manual source reveals textarea', !!area]);
    if(area) setVal(area,'Custom verse body here');
  }

  // ---- add each element type, select it, ensure inspector builds w/o error ----
  // Resolve each type to its REAL button label. The old ad-hoc regex mapped 'history' to
  // 'Event', so it clicked the Event-list button twice and never added the Scripture-ref-list
  // type this assertion claims to cover — while 'eventList' was not in the list at all.
  const LABELS={reference:'Reference',name:'Name',sermonTitle:'Sermon',bulletList:'Bullet',
                history:'Scripture ref list',eventList:'Event list',text:'Text',
                clock:'Timer',qr:'QR'};
  const types=['reference','name','sermonTitle','bulletList','history','eventList','text','clock','qr'];
  let addErrs=0;
  types.forEach(t=>{
    const before=errors.length;
    const add=[...D.querySelectorAll('.addmenu .btn')].find(b=>new RegExp(LABELS[t]||t,'i').test(b.textContent));
    if(add){ click(add); } else { errors.push('add btn missing for '+t); }
    if(errors.length!==before) addErrs++;
  });
  out.push(['adding+inspecting all element types: no errors', addErrs===0]);

  // ---- transition (take) works + revert ----
  const beforeTake=errors.length;
  click(D.getElementById('btnTrans'));
  click(D.getElementById('btnRevert'));
  out.push(['transition + revert: no errors', errors.length===beforeTake]);

  // ---- preset: new folder + save preset (prompt stubbed) ----
  // Naming uses an in-page dialog now: Electron does not implement window.prompt,
  // so the old prompt() flow was a silent no-op in the packaged app.
  function answerAsk(text){
    const ask=D.querySelector('.lt-ask'); if(!ask)return false;
    const i=ask.querySelector('input'); if(i){ i.value=text; i.dispatchEvent(new W.Event('input',{bubbles:true})); }
    const okb=ask.querySelector('[data-ask="ok"]'); if(okb)click(okb);
    return true;
  }
  const bSave=findBtn(/Save preview as preset/);
  if(bSave){ const be=errors.length; click(bSave);
    out.push(['save preset: naming dialog opened', !!D.querySelector('.lt-ask')]);
    answerAsk('Swept Preset');
    await new Promise(r=>setTimeout(r,30));   // let the dialog's promise settle
    out.push(['save preset: no errors', errors.length===be]);
    out.push(['preset row created with SVG icons', [...D.querySelectorAll('.preset .ic')].every(b=>b.querySelector('svg')) && D.querySelectorAll('.preset').length>0]); }

  out.forEach(([n,ok])=>console.log((ok?'PASS':'**FAIL**')+'  '+n));
  console.log('TOTAL ERRORS: '+(errors.length?JSON.stringify(errors.slice(0,8)):'none'));
  process.exit(0);
},600);
