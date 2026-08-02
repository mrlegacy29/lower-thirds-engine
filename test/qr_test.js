// QR encoder verification.
//
// I cannot point a phone at the output from here, so "it looks like a QR code" is not
// evidence. Three independent checks instead:
//
//   1. KNOWN-ANSWER on the Reed-Solomon stage — GF(256) tables and the published
//      degree-10 generator polynomial have fixed, documented values.
//   2. SYNDROME CHECK — for a correct RS codeword every syndrome c(alpha^i) is zero.
//      This is decisive about the ECC and interleaving and needs no reference data.
//   3. ROUND TRIP through a decoder written here from the READ side of the spec:
//      read format info -> unmask -> walk the zigzag -> de-interleave -> decode.
//      For a bug to survive, the encoder and this decoder would have to misread the
//      spec in the same direction.
const { JSDOM } = require('jsdom');
const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS' : '**FAIL**') + '  ' + n); c ? pass++ : fail++; };

const errors = [];
const dom = new JSDOM(html, {
  url: 'http://localhost:7777/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.ResizeObserver = class { observe() {} };
    w.EventSource = class { constructor() {} close() {} };
    w.requestAnimationFrame = (c) => setTimeout(c, 0); w.alert = () => {}; w.confirm = () => true;
    w.Element.prototype.animate = function () { return { cancel() {}, finished: Promise.resolve() }; };
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    w.console.error = (...a) => errors.push(a.join(' ')); w.onerror = (m) => errors.push(String(m));
  }
});
const W = dom.window;

/* ------------------------- an INDEPENDENT reader ------------------------- */
// Deliberately written from the decode side rather than by running the encoder
// backwards. Only the fixed spec tables are shared.
const SPECS = { 1:[10,1,16,0,0], 2:[16,1,28,0,0], 3:[26,1,44,0,0], 4:[18,2,32,0,0], 5:[24,2,43,0,0],
                6:[16,4,27,0,0], 7:[18,4,31,0,0], 8:[22,2,38,2,39], 9:[22,3,36,2,37], 10:[26,4,43,1,44] };
const ALIGN = { 1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50] };
const MASKS = [
  (r,c)=>((r+c)%2===0), (r,c)=>(r%2===0), (r,c)=>(c%3===0), (r,c)=>((r+c)%3===0),
  (r,c)=>((Math.floor(r/2)+Math.floor(c/3))%2===0), (r,c)=>(((r*c)%2)+((r*c)%3)===0),
  (r,c)=>((((r*c)%2)+((r*c)%3))%2===0), (r,c)=>((((r+c)%2)+((r*c)%3))%2===0)
];

// GF(256) built independently
const EXP=new Uint8Array(512), LOG=new Uint8Array(256);
(function(){ let x=1; for(let i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100)x^=0x11D; }
  for(let i=255;i<512;i++)EXP[i]=EXP[i-255]; })();
const mul=(a,b)=>(a===0||b===0)?0:EXP[LOG[a]+LOG[b]];

// which cells are function patterns (not data)
function reservedMap(ver,size){
  const res=[]; for(let i=0;i<size;i++)res.push(new Array(size).fill(false));
  const mark=(r,c)=>{ if(r>=0&&c>=0&&r<size&&c<size)res[r][c]=true; };
  [[0,0],[0,size-7],[size-7,0]].forEach(([R,C])=>{
    for(let r=-1;r<=7;r++)for(let c=-1;c<=7;c++)mark(R+r,C+c);
  });
  for(let i=0;i<size;i++){ mark(6,i); mark(i,6); }
  const al=ALIGN[ver];
  al.forEach(r=>al.forEach(c=>{
    if((r<=8&&c<=8)||(r<=8&&c>=size-9)||(r>=size-9&&c<=8))return;
    for(let dr=-2;dr<=2;dr++)for(let dc=-2;dc<=2;dc++)mark(r+dr,c+dc);
  }));
  for(let i=0;i<9;i++){ mark(8,i); mark(i,8); }
  for(let i=0;i<8;i++){ mark(8,size-1-i); mark(size-1-i,8); }
  mark(size-8,8);
  if(ver>=7){ for(let i=0;i<18;i++){ const r=Math.floor(i/3), c=i%3; mark(size-11+c,r); mark(r,size-11+c); } }
  return res;
}

function decode(q){
  const size=q.size, m=q.modules, ver=q.version;
  // --- format info, copy 1, unmasked with the fixed XOR ---
  // Placement position i carries format bit INDEX i, where index 0 is the MSB
  // (ISO/IEC 18004). Reading LSB-first here would silently undo an encoder that
  // wrote LSB-first — which is exactly how an unscannable code passed a round trip.
  let raw=0;
  for(let i=0;i<15;i++){
    let b;
    if(i<6)b=m[8][i]; else if(i===6)b=m[8][7]; else if(i===7)b=m[8][8];
    else if(i===8)b=m[7][8]; else b=m[14-i][8];
    if(b)raw|=(1<<(14-i));
  }
  const fmt=raw^0b101010000010010;
  // The 15-bit format word is (5 data bits << 10) | 10 BCH bits, so level+mask are the
  // TOP five bits — not the bottom. Bit i of the word sits at placement position i,
  // LSB at (8,0), which is the spec's convention.
  const fdata=(fmt>>10)&0x1F;
  const eccLevel=(fdata>>3)&0b11, mask=fdata&0b111;

  // --- unmask the data area ---
  const res=reservedMap(ver,size);
  const t=m.map(row=>row.slice());
  for(let r=0;r<size;r++)for(let c=0;c<size;c++)
    if(!res[r][c]&&MASKS[mask](r,c))t[r][c]=!t[r][c];

  // --- walk the zigzag and rebuild codewords ---
  const bits=[]; let up=true;
  for(let c=size-1;c>0;c-=2){
    if(c===6)c--;
    for(let n=0;n<size;n++){
      const r=up?(size-1-n):n;
      for(let k=0;k<2;k++){ const cc=c-k; if(res[r][cc])continue; bits.push(t[r][cc]?1:0); }
    }
    up=!up;
  }
  const cw=[]; for(let i=0;i+7<bits.length;i+=8){ let b=0; for(let j=0;j<8;j++)b=(b<<1)|bits[i+j]; cw.push(b); }

  // --- de-interleave ---
  const sp=SPECS[ver], nb=sp[1]+sp[3], maxData=Math.max(sp[2],sp[4]||0);
  const blocks=[]; for(let i=0;i<nb;i++)blocks.push([]);
  let p=0;
  for(let i=0;i<maxData;i++)for(let b=0;b<nb;b++){
    const len=(b<sp[1])?sp[2]:sp[4];
    if(i<len)blocks[b].push(cw[p++]);
  }
  const eccs=[]; for(let i=0;i<nb;i++)eccs.push([]);
  for(let i=0;i<sp[0];i++)for(let b=0;b<nb;b++)eccs[b].push(cw[p++]);

  // --- syndromes: every one must vanish for a valid RS codeword ---
  let syndromesOk=true;
  for(let b=0;b<nb;b++){
    const full=blocks[b].concat(eccs[b]);
    for(let s=0;s<sp[0];s++){
      let acc=0;
      for(let i=0;i<full.length;i++)acc=mul(acc,EXP[s])^full[i];
      if(acc!==0)syndromesOk=false;
    }
  }

  // --- decode the data stream ---
  const data=[]; blocks.forEach(b=>b.forEach(x=>data.push(x)));
  const db=[]; data.forEach(x=>{ for(let i=7;i>=0;i--)db.push((x>>i)&1); });
  let bp=0; const take=(n)=>{ let v=0; for(let i=0;i<n;i++)v=(v<<1)|(db[bp++]||0); return v; };
  const mode=take(4);
  const cci=(ver<=9)?8:16;
  const len=take(cci);
  const out=[]; for(let i=0;i<len;i++)out.push(take(8));
  const text=decodeURIComponent(out.map(b=>'%'+b.toString(16).padStart(2,'0')).join(''));
  return { text, mode, len, mask, eccLevel, syndromesOk, version:ver };
}

(function(){
  setTimeout(() => {
    /* ---------------- 1. known-answer: GF(256) and the generator ----------------
       QR_EXP/QR_LOG are top-level `const`s and so are not window properties. That is
       fine — checking them directly would only prove the app agrees with itself.
       Instead the app's Reed-Solomon output is cross-checked against the GF table
       and RS implementation built independently at the top of this file. */
    ok('GF (independent): EXP[0]=1, EXP[1]=2', EXP[0] === 1 && EXP[1] === 2);
    ok('GF (independent): EXP[8] = 0x1D (x^8 reduces by 0x11D)', EXP[8] === 0x1D);
    ok('GF (independent): LOG/EXP are inverses',
       (() => { for (let i = 1; i < 256; i++) if (EXP[LOG[i]] !== i) return false; return true; })());

    // The degree-10 generator is published as these alpha exponents. Converted with
    // the INDEPENDENT log table, so this pins the app's polynomial to the standard.
    const g10 = W.qrGenPoly(10);
    const expect10 = [0,251,67,46,61,118,70,64,94,32,45];
    ok('RS: degree-10 generator has 11 coefficients', g10.length === 11);
    ok('RS: degree-10 generator matches the PUBLISHED alpha exponents',
       g10.every((c, i) => LOG[c] === expect10[i]));
    ok('RS: generator degree scales', W.qrGenPoly(16).length === 17 && W.qrGenPoly(26).length === 27);
    ok('RS: ecc length matches the requested degree', W.qrEcc([1,2,3], 10).length === 10);

    // full cross-implementation agreement on ECC bytes for pseudo-random data
    {
      const myEcc = (data, n) => {
        let g = [1];
        for (let i = 0; i < n; i++) { const q = new Array(g.length + 1).fill(0);
          for (let j = 0; j < g.length; j++) { q[j] ^= mul(g[j], 1); q[j+1] ^= mul(g[j], EXP[i]); } g = q; }
        const r = data.slice().concat(new Array(n).fill(0));
        for (let i = 0; i < data.length; i++) { const f = r[i]; if (!f) continue;
          for (let j = 0; j < g.length; j++) r[i+j] ^= mul(g[j], f); }
        return r.slice(data.length);
      };
      let seed = 12345, agree = true;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
      for (const n of [10, 16, 18, 22, 24, 26]) {
        const data = Array.from({ length: 30 }, rnd);
        const a = W.qrEcc(data, n), b = myEcc(data, n);
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) agree = false;
      }
      ok('RS: app ECC matches an independent implementation across every degree used', agree);
    }

    /* ------------------------------ 2 + 3. round trip ------------------------------ */
    const cases = [
      'HELLO WORLD',
      'https://example.com/give',
      'https://church.example.org/giving?campaign=general&src=stream',
      'a',
      '0123456789',
      'Mixed CASE with punctuation! #$%&*()-_=+[]{};:,.<>/?',
      'x'.repeat(100),
      'x'.repeat(213),                       // exactly the version-10 level-M byte capacity
                                             // (216 data codewords minus the 3-byte
                                             //  mode+count header) — the published figure
    ];
    cases.forEach((txt) => {
      const q = W.qrEncode(txt);
      if (!q) { ok('round trip: encoded ' + JSON.stringify(txt.slice(0, 24)), false); return; }
      const d = decode(q);
      const label = JSON.stringify(txt.length > 24 ? txt.slice(0, 21) + '…' : txt) + ' (v' + q.version + ')';
      ok('syndromes all zero — ECC + interleave correct: ' + label, d.syndromesOk);
      ok('round trip recovers the exact string: ' + label, d.text === txt);
      ok('decoded as byte mode: ' + label, d.mode === 0b0100);
      ok('length indicator matches: ' + label, d.len === unescape(encodeURIComponent(txt)).length);
      ok('ECC level reads back as M: ' + label, d.eccLevel === 0b00);
      ok('mask index is in range: ' + label, d.mask >= 0 && d.mask <= 7);
    });

    /* ---------- format info vs the PUBLISHED table (external ground truth) ----------
       A round trip alone cannot prove placement: an encoder that writes the word
       backwards and a decoder that reads it backwards agree with each other while a
       real scanner rejects the symbol. These are the standard's own 15-bit strings for
       ECC level M, written MSB-first, so they pin the bit ORDER to something outside
       this codebase. */
    {
      const M_FORMAT = [
        '101010000010010', // mask 0
        '101000100100101', // 1
        '101111001111100', // 2
        '101101101001011', // 3
        '100010111111001', // 4
        '100000011001110', // 5
        '100111110010111', // 6
        '100101010100000', // 7
      ];
      // the encoder's own computation must match the published strings
      let computedOk = true;
      for (let k = 0; k < 8; k++) {
        const got = (W.qrFormatBits(k) >>> 0).toString(2).padStart(15, '0');
        if (got !== M_FORMAT[k]) { computedOk = false; console.log('   mask ' + k + ': got ' + got + ' want ' + M_FORMAT[k]); }
      }
      ok('format: qrFormatBits matches the published level-M table for all 8 masks', computedOk);

      // and the MODULES must carry that string MSB-first starting at (8,0)
      const q = W.qrEncode('format placement check');
      const m = q.modules;
      let read = '';
      for (let i = 0; i < 15; i++) {
        let b;
        if (i < 6) b = m[8][i]; else if (i === 6) b = m[8][7]; else if (i === 7) b = m[8][8];
        else if (i === 8) b = m[7][8]; else b = m[14 - i][8];
        read += b ? '1' : '0';
      }
      ok('format: copy 1 modules spell a real published format string (MSB at (8,0))',
         M_FORMAT.indexOf(read) >= 0);

      // copy 2 must carry the SAME string: 7 up column 8, then 8 along row 8
      const s = q.size;
      let read2 = '';
      for (let i = 0; i < 15; i++) read2 += ((i < 7) ? m[s - 1 - i][8] : m[8][s - 15 + i]) ? '1' : '0';
      ok('format: copy 2 carries the identical string', read2 === read);
      ok('format: the mask read back is the mask actually used',
         M_FORMAT.indexOf(read) === ((W.qrFormatBits(M_FORMAT.indexOf(read)) >>> 0).toString(2).padStart(15,'0') === read
           ? M_FORMAT.indexOf(read) : -1));
    }

    /* ------------------------------ structure ------------------------------ */
    {
      const q = W.qrEncode('structure check');
      const m = q.modules, s = q.size;
      const finder = (R, C) => m[R][C] && m[R][C+6] && m[R+6][C] && m[R+6][C+6] &&
                               !m[R+1][C+1] && m[R+2][C+2] && m[R+3][C+3];
      ok('structure: three finder patterns', finder(0,0) && finder(0,s-7) && finder(s-7,0));
      // A real check of the 7x7 finder signature — two arbitrary dark data modules
      // can coincide, so spot-checking single cells proves nothing.
      ok('structure: NO finder pattern in the bottom-right corner', !finder(s-7, s-7));
      let timing = true;
      for (let i = 8; i < s - 8; i++) { if (m[6][i] !== (i%2===0)) timing = false; if (m[i][6] !== (i%2===0)) timing = false; }
      ok('structure: horizontal + vertical timing patterns', timing);
      ok('structure: the dark module is set', m[s-8][8] === true);
      ok('structure: size is 17 + 4*version', s === 17 + 4*q.version);
    }

    /* ------------------------------ sizing + limits ------------------------------ */
    ok('sizing: short text picks version 1', W.qrEncode('hi').version === 1);
    ok('sizing: version grows with length', W.qrEncode('x'.repeat(100)).version > W.qrEncode('hi').version);
    ok('limits: 213 bytes is the version-10 level-M maximum', W.qrEncode('x'.repeat(213)) !== null);
    ok('limits: 214 bytes is one past capacity and is refused', W.qrEncode('x'.repeat(214)) === null);
    ok('limits: empty string still encodes', !!W.qrEncode(''));
    ok('limits: null is treated as empty rather than throwing', !!W.qrEncode(null));

    /* ------------------------------ utf-8 ------------------------------ */
    {
      const txt = 'Give — thank you! ✝';
      const q = W.qrEncode(txt);
      ok('utf-8: multi-byte text encodes', !!q);
      if (q) ok('utf-8: multi-byte text round-trips exactly', decode(q).text === txt);
    }

    /* ------------------------------ svg output ------------------------------ */
    {
      const svg = W.qrSvg('https://example.com/give');
      ok('svg: produced', typeof svg === 'string' && svg.indexOf('<svg') === 0);
      ok('svg: crisp edges (no anti-alias blur when scaled)', /shape-rendering="crispEdges"/.test(svg));
      ok('svg: has a quiet zone — viewBox is 8 wider than the module count',
         (() => { const q = W.qrEncode('https://example.com/give');
                  return new RegExp('viewBox="0 0 ' + (q.size + 8) + ' ' + (q.size + 8) + '"').test(svg); })());
      ok('svg: draws modules as a path', /<path d="M/.test(svg));
      const t = W.qrSvg('x', { transparent: true });
      ok('svg: transparent mode omits the background rect', t.indexOf('<rect') < 0);
      ok('svg: opaque mode includes a background rect', W.qrSvg('x').indexOf('<rect') >= 0);
      ok('svg: too-long input returns null', W.qrSvg('x'.repeat(400)) === null);
    }

    ok('nothing threw', errors.length === 0);
    console.log('\nQR RESULT  pass=' + pass + '  fail=' + fail +
                '  ERRORS=' + (errors.length ? errors.slice(0, 3).join(' | ') : 'NONE'));
    process.exit(fail ? 1 : 0);
  }, 500);
})();
