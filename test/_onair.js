// Shared "is this ACTUALLY on air?" helper for the suites that judge the OBS output page.
//
// WHY: five suites asked `out().includes(x)`, where out() was
//     (D.querySelector('#out-scaler')||{}).textContent
// textContent counts nodes the engine has taken OFF AIR. The engine hides an element by
// setting opacity:0 on its .lt-el wrapper (lt.html:2161) and hides individual nodes with
// display:none. So every POSITIVE on-air assertion was really asserting "this text exists
// somewhere in the DOM" — the engine could composite the correct text fully transparent
// into the OBS browser source, the classic lost-graphics-on-air failure, and npm test would
// still report ALL SUITES PASSED.
//
// EQUALLY IMPORTANT — do NOT filter on getBoundingClientRect(). It returns 0x0 in jsdom and
// in any non-compositing context, so a size filter reports EVERYTHING as invisible and makes
// the assertions vacuous in the other direction. That mistake has been made here too.
// display / visibility / opacity are the reliable signals.

function painted(node, W, D) {
  let a = node;
  while (a && a !== D.body && a.nodeType === 1) {
    const cs = W.getComputedStyle(a);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity || '1') === 0) return false;
    a = a.parentElement;
  }
  return true;
}

// All painted text under `sel` (default the OBS output stage), space-joined.
//
// Walk TEXT NODES, not "element leaves". An earlier version filtered elements by
// !n.children.length, which silently dropped real on-air text: .r-ref is a <div> holding a
// BARE TEXT NODE ("Psalm 23:1") plus a <span class="tr">ESV</span>. The div has an element
// child so it was excluded, and the bare text node never appears in querySelectorAll('*') —
// so the reference vanished from the result and correct renders looked broken.
function onAirText(D, W, sel) {
  const root = D.querySelector(sel || '#out-scaler');
  if (!root) return '';
  const out = [];
  const walk = D.createTreeWalker(root, W.NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walk.nextNode())) {
    const t = (n.nodeValue || '').trim();
    if (t && painted(n.parentElement, W, D)) out.push(t);
  }
  return out.join(' ');
}

// Painted nodes matching a selector — for assertions scoped to one element's own nodes.
function onAirNodes(D, W, sel, within) {
  const root = D.querySelector(within || '#out-scaler');
  if (!root) return [];
  return [...root.querySelectorAll(sel)].filter(n => painted(n, W, D));
}

module.exports = { painted, onAirText, onAirNodes };
