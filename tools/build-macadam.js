#!/usr/bin/env node
/* Build macadam (DeckLink fill+key bindings) so it loads inside this app's Electron.
 *
 * Run:  node tools/build-macadam.js
 *
 * WHY THIS SCRIPT EXISTS — `npm install macadam` fails on a modern toolchain for three
 * separate reasons, and the error messages point at none of them:
 *
 *  1. MAX_PATH. The build dies with
 *       error C1083: Cannot open compiler generated file: '': Invalid argument
 *     an EMPTY filename, which is MSVC overflowing 260 chars — not a source problem. It
 *     surfaces in the `segfault-handler` dependency first, which sends you chasing the
 *     wrong module entirely. Build from a SHORT path (this script uses C:\_ltmacadam).
 *
 *  2. Node 22+ split the N-API finalizer types. macadam's sources `#define NAPI_EXPERIMENTAL`
 *     (they needed thread-safe functions back in 2019), which now activates the strict
 *     signatures, and three call sites fail with:
 *       C2664: cannot convert argument from 'void (*)(napi_env,void*,void*)'
 *              to 'node_api_basic_finalize'
 *     Node ships the official escape hatch for exactly this — defining
 *     NODE_API_EXPERIMENTAL_NOGC_ENV_OPT_OUT makes node_api_basic_finalize an alias for
 *     plain napi_finalize again (see js_native_api_types.h). One define fixes all three.
 *
 *  3. `segfault-handler`, a hard dependency, is an abandoned NAN addon (2018). NAN addons
 *     are ABI-locked, so it will not load in Electron even when it compiles for Node, and
 *     it is only a debug aid that prints a stack trace on segfault. We make the require
 *     optional rather than shipping a second native module to rebuild for every ABI.
 *
 * macadam vendors the Blackmagic SDK headers (decklink/Win/include), so the Desktop Video
 * SDK does NOT need to be installed to BUILD. The Desktop Video DRIVER is still required at
 * RUNTIME — without it every call throws "Unable to load DeckLinkAPI." (cleanly, no crash).
 *
 * Needs "Desktop development with C++" in the Visual Studio Build Tools installer.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUILD_DIR = 'C:\\_ltmacadam';                 // short: see reason 1 above
const DEST = path.join(__dirname, '..', 'vendor', 'macadam');

const electronVersion = (() => {
  try { return require('electron/package.json').version; }
  catch (e) { return require('../package.json').devDependencies.electron.replace(/^[^\d]*/, ''); }
})();

const run = (cmd, args, cwd) => {
  console.log('  > ' + cmd + ' ' + args.join(' '));
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
};

console.log('Building macadam for Electron ' + electronVersion);

if (fs.existsSync(BUILD_DIR)) fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

run('npm', ['init', '-y'], BUILD_DIR);
// --ignore-scripts: we patch before anything compiles
run('npm', ['install', 'macadam', '--ignore-scripts', '--no-audit', '--no-fund'], BUILD_DIR);

const mac = path.join(BUILD_DIR, 'node_modules', 'macadam');

// reason 2 — the one define that makes it compile
const gypPath = path.join(mac, 'binding.gyp');
let gyp = fs.readFileSync(gypPath, 'utf8');
if (!gyp.includes('NODE_API_EXPERIMENTAL_NOGC_ENV_OPT_OUT')) {
  gyp = gyp.replace('"target_name" : "macadam",',
    '"target_name" : "macadam",\n    "defines": [ "NODE_API_EXPERIMENTAL_NOGC_ENV_OPT_OUT" ],');
  fs.writeFileSync(gypPath, gyp);
  console.log('  patched binding.gyp (N-API finalizer opt-out)');
}

// reason 3 — drop the abandoned NAN dependency
const idxPath = path.join(mac, 'index.js');
let idx = fs.readFileSync(idxPath, 'utf8');
if (idx.includes("var SegfaultHandler = require('segfault-handler');")) {
  idx = idx.replace("var SegfaultHandler = require('segfault-handler');",
    "var SegfaultHandler = null;\ntry { SegfaultHandler = require('segfault-handler'); } catch (e) { SegfaultHandler = null; }");
  idx = idx.replace("SegfaultHandler.registerHandler('crash.log');",
    "if (SegfaultHandler) SegfaultHandler.registerHandler('crash.log');");
  fs.writeFileSync(idxPath, idx);
  console.log('  patched index.js (segfault-handler now optional)');
}

// reason 4 — `bindings` searches a dozen paths at runtime to find the .node, which does not
// survive being vendored (and breaks again inside an asar). We know exactly where the binary
// is, so require it directly. That also drops the `bindings` + `file-uri-to-path` deps.
// `highland` is declared by macadam but never referenced in index.js, so it goes too.
if (idx.includes("require('bindings')('macadam')")) {
  idx = idx.replace("require('bindings')('macadam')",
    "require('./build/Release/macadam.node')");
  fs.writeFileSync(idxPath, idx);
  console.log('  patched index.js (direct .node require, no `bindings`)');
}

// build against ELECTRON's headers, not the system Node's
run('npx', ['node-gyp', 'rebuild',
  '--target=' + electronVersion, '--arch=x64',
  '--dist-url=https://electronjs.org/headers'], mac);

const built = path.join(mac, 'build', 'Release', 'macadam.node');
if (!fs.existsSync(built)) { console.error('BUILD PRODUCED NO macadam.node'); process.exit(1); }

// vendor the result into the repo so electron-builder can package it
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.join(DEST, 'build', 'Release'), { recursive: true });
for (const f of ['index.js', 'package.json', 'LICENSE', 'README.md']) {
  const src = path.join(mac, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DEST, f));
}
fs.copyFileSync(built, path.join(DEST, 'build', 'Release', 'macadam.node'));
// macadam resolves its binary through `bindings`, which needs this marker
fs.writeFileSync(path.join(DEST, 'build', 'Release', '.keep'), '');

console.log('\nOK — vendored to ' + DEST);
console.log('Verify with:  ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "require(\'./vendor/macadam\')"');
console.log('Runtime still needs Blackmagic Desktop Video installed, and a DeckLink card.');
