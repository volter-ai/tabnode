// Where a synchronous child's output goes, by what `stdio` says. Run it under Node and as a guest of the built
// engine: the two print the same lines in the same order on the same streams.
//
// `stdio: 'inherit'` is the case every package script meets (npm, a start script, test/common's re-run of a
// `// Flags:` file): Node hands the binding `{ type: 'fd', fd: 0|1|2 }` for it, not `{ type: 'inherit' }`.
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.argv[2] === 'child') {
  console.log('B out');
  console.error('B err');
  return;
}
const child = [__filename, 'child'];
console.log('A');
const whole = spawnSync(process.execPath, child, { stdio: 'inherit' });
console.log('C status=' + whole.status + ' stdout=' + JSON.stringify(whole.stdout) + ' stderr=' + JSON.stringify(whole.stderr));
const one = spawnSync(process.execPath, child, { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
console.log('D stdout=' + JSON.stringify(one.stdout) + ' stderr=' + JSON.stringify(one.stderr));
execSync(JSON.stringify(process.execPath) + ' ' + JSON.stringify(__filename) + ' child', { stdio: 'inherit' });
console.log('E');
const file = path.join(process.cwd(), 'sync-child-stdio.log');
const log = fs.openSync(file, 'w');
const filed = spawnSync(process.execPath, child, { stdio: ['ignore', log, log] });
fs.closeSync(log);
console.log('F stdout=' + JSON.stringify(filed.stdout) + ' file=' + JSON.stringify(fs.readFileSync(file, 'utf8')));
fs.unlinkSync(file);
// Bytes passed on are not a buffer of this call's: one byte of `maxBuffer` is not exceeded by them.
const crossed = spawnSync(process.execPath, child, { stdio: ['ignore', 2, 1], maxBuffer: 1 });
console.log('G error=' + (crossed.error && crossed.error.code));
