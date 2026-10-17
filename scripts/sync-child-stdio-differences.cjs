// What a synchronous child's stdio does NOT yet do as Node does: run under Node and as a guest of the built engine and
// read the lines that differ. CHANGELOG.md's "Known differences from Node" states each; a line that comes to match
// leaves that list. Give Node something on stdin when running it by hand (a terminal's fd 3 is not a child's).
const { spawnSync } = require('child_process');
const fs = require('fs'); const path = require('path');
if (process.argv[2] === 'cat') { let s = ''; process.stdin.on('data', (d) => s += d); process.stdin.on('end', () => console.log('child read ' + JSON.stringify(s))); return; }
if (process.argv[2] === 'fd3') { try { fs.writeSync(3, 'to fd 3\n'); console.log('child wrote fd 3'); } catch (e) { console.log('child fd 3: ' + e.code); } return; }
const say = (label, f) => { try { console.log(label + ' ' + f()); } catch (e) { console.log(label + ' THROWS ' + (e.code || e.name) + ': ' + String(e.message).slice(0, 90)); } };
// 2a. the child's fd 0 is a file of the caller's
const file = path.join(process.cwd(), 'sib-in.txt'); fs.writeFileSync(file, 'from a file');
say('2a stdin=fd of a file:', () => { const fd = fs.openSync(file, 'r'); const r = spawnSync(process.execPath, [__filename, 'cat'], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' }); fs.closeSync(fd); return JSON.stringify(r.stdout) + ' status=' + r.status; });
// 3a. a pipe past fd 2
say('3a stdio[3]=pipe:', () => { const r = spawnSync(process.execPath, [__filename, 'fd3'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8' }); return 'stdout=' + JSON.stringify(r.stdout) + ' output[3]=' + JSON.stringify(r.output && r.output[3]); });
// 3b. a file's descriptor past fd 2
say('3b stdio[3]=fd of a file:', () => { const out = path.join(process.cwd(), 'sib-out.txt'); const fd = fs.openSync(out, 'w'); const r = spawnSync(process.execPath, [__filename, 'fd3'], { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8' }); fs.closeSync(fd); const got = fs.readFileSync(out, 'utf8'); fs.unlinkSync(out); return 'stdout=' + JSON.stringify(r.stdout) + ' file=' + JSON.stringify(got); });
// 3c. a stream object
say('3c stdio[1]=process.stdout (a stream):', () => { const r = spawnSync(process.execPath, [__filename, 'fd3'], { stdio: ['ignore', process.stdout, 'pipe'], encoding: 'utf8' }); return 'stdout=' + JSON.stringify(r.stdout) + ' status=' + r.status; });
say('3d stdio[1]=a file WriteStream:', () => { const out = path.join(process.cwd(), 'sib-ws.txt'); const fd = fs.openSync(out, 'w'); const ws = fs.createWriteStream(null, { fd }); const r = spawnSync(process.execPath, [__filename, 'fd3'], { stdio: ['ignore', ws, 'pipe'], encoding: 'utf8' }); const got = fs.readFileSync(out, 'utf8'); return 'stdout=' + JSON.stringify(r.stdout) + ' file=' + JSON.stringify(got); });
fs.unlinkSync(file);
