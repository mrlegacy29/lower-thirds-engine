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
                'relay_test','output_test','pp_resilience_test','clear_rule_test'];
let failed = 0;
for (const s of suites) {
  process.stdout.write(s.padEnd(20) + ' ');
  try {
    const out = execFileSync('node', [path.join(__dirname, s + '.js')], { encoding: 'utf8' });
    const line = out.split('\n').filter(l => /TOTAL ERRORS|RESULT|ERRORS:/.test(l)).pop() || 'ok';
    // Older suites call process.exit(0) unconditionally, so a non-zero exit isn't enough —
    // also treat any "**FAIL**" line in the output as a failure so nothing hides.
    if (/\*\*FAIL\*\*/.test(out)) {
      failed++;
      const fails = out.split('\n').filter(l => /\*\*FAIL\*\*/.test(l)).slice(0, 3).map(l => l.trim()).join(' | ');
      console.log('FAILED  ' + fails);
    } else { console.log(line.trim()); }
  } catch (e) {
    failed++;
    const out = (e.stdout || '') + (e.stderr || '');
    const line = out.split('\n').filter(l => /FAIL|ERROR/.test(l)).slice(0,3).join(' | ') || 'FAILED';
    console.log('FAILED  ' + line);
  }
}
console.log('\n' + (failed ? failed + ' suite(s) FAILED' : 'ALL SUITES PASSED'));
process.exit(failed ? 1 : 0);
