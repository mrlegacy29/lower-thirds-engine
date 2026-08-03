// Runs every test suite as a child process and aggregates the result.
const { execFileSync } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');

// 1) syntax check the single-file app first
const html = fs.readFileSync(path.join(__dirname, '..', 'lt.html'), 'utf8');
const m = html.match(/<script\b[^>]*>([\s\S]*)<\/script>/i);
if (!m) { console.error('Could not extract <script> block from lt.html'); process.exit(1); }
const checkFile = path.join(os.tmpdir(), '_lt_check.js');   // os.tmpdir() always exists (Windows %TEMP%, POSIX /tmp)
fs.writeFileSync(checkFile, m[1]);
try { execFileSync('node', ['--check', checkFile], { stdio: 'pipe' }); }
catch (e) { console.error('SYNTAX ERROR in lt.html:\n' + e.stdout + e.stderr); process.exit(1); }
console.log('syntax OK\n');

const suites = ['final_check2','exclude_test2','sweep','evtest4',
                'media_motion_test','motion_waapi_test','layer_dock_test','operator_test','custom_take_test',
                'relay_test','output_test','pp_resilience_test','clear_rule_test','manual_source_test',
                'source_fallback_test','sdi_test','relay_security_test','graphics_io_test','clock_test','theme_rules_test','qr_test','qr_smoke_test','databind_test','audit_fixes_test'];

// A suite that never exits used to hang the whole run indefinitely — loading lt.html in
// JSDOM starts the app's setInterval timers, which hold Node's event loop open unless the
// suite calls process.exit(). One ad-hoc probe ran for 44 HOURS before anyone noticed.
// Cap every suite so a hang fails loudly instead of silently wedging `npm test`.
const SUITE_TIMEOUT_MS = 120000;

let failed = 0;
for (const s of suites) {
  process.stdout.write(s.padEnd(20) + ' ');
  try {
    const out = execFileSync('node', [path.join(__dirname, s + '.js')],
                             { encoding: 'utf8', timeout: SUITE_TIMEOUT_MS });
    const line = out.split('\n').filter(l => /TOTAL ERRORS|RESULT|ERRORS:/.test(l)).pop() || 'ok';
    // Older suites call process.exit(0) unconditionally, so a non-zero exit isn't enough —
    // also treat any "**FAIL**" line in the output as a failure so nothing hides.
    // SECOND NET: a suite can also report trouble as "TOTAL ERRORS: [...]" or "ERRORS=THREW".
    // That line was previously printed verbatim as the suite's *result* without checking
    // whether it said NONE, so a suite could announce its own errors and still count green.
    const errsNotNone = /ERRORS[:=]\s*(?!NONE\b|none\b)\S/.test(out);
    if (/\*\*FAIL\*\*/.test(out) || errsNotNone) {
      failed++;
      const fails = out.split('\n').filter(l => /\*\*FAIL\*\*/.test(l)).slice(0, 3).map(l => l.trim()).join(' | ');
      // when the trigger was the error line rather than a **FAIL** token, show that instead
      console.log('FAILED  ' + (fails || line.trim()));
    } else { console.log(line.trim()); }
  } catch (e) {
    failed++;
    if (e.killed || e.signal) {                      // execFileSync kills on timeout
      console.log('FAILED  TIMED OUT after ' + (SUITE_TIMEOUT_MS / 1000) +
                  's — the suite never exited (missing process.exit()?)');
      continue;
    }
    const out = (e.stdout || '') + (e.stderr || '');
    const line = out.split('\n').filter(l => /FAIL|ERROR/.test(l)).slice(0,3).join(' | ') || 'FAILED';
    console.log('FAILED  ' + line);
  }
}
console.log('\n' + (failed ? failed + ' suite(s) FAILED' : 'ALL SUITES PASSED'));
process.exit(failed ? 1 : 0);
