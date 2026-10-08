// Where `process.nextTick` callbacks run relative to promises, for code entered two ways a comparison of plain
// callbacks does not reach. Run under Node and as a guest of the built engine: both print one `ORDER` line, the same.
//
// 1. A binding's callback that arrives while other `await`s are resuming: Node runs the callback, then every tick it
//    queued, then the promises it queued (`<name>:cb <name>:tick <name>:promise`), whatever else is settling.
// 2. Guest code entered from a listener on an event target of the realm's own (an AbortSignal's timeout, a message
//    port, a BroadcastChannel, an EventTarget dispatched from a microtask): a child that cannot start reports it on
//    a later tick, so an `error` listener attached right after `spawn` hears it (`<name>: error ENOENT`). Ticks
//    drained while that code is still running would emit it before the listener is there.
const fs = require('fs'), zlib = require('zlib'), crypto = require('crypto'), dns = require('dns');
const { spawn, exec } = require('child_process');
const out = []; const say = (text) => out.push(text);
// An `error` nobody heard is said, with what was being entered, and the run goes on to the next.
let entering = 'nothing';
process.on('uncaughtException', (error) => say(entering + ': UNHEARD ' + (error && error.code)));
const settle = () => new Promise((done) => setImmediate(done));
// Awaits resuming in the same checkpoints as whatever is under test.
const busy = async () => { for (let turn = 0; turn < 200; turn += 1) await null; };

async function binding(name, start) {
  entering = name;
  const others = [busy(), busy()];
  await new Promise((done) => start(() => {
    process.nextTick(() => say(name + ':tick'));
    Promise.resolve().then(() => say(name + ':promise'));
    say(name + ':cb');
    setImmediate(done);
  }));
  await Promise.all(others);
}

function child(name) {
  entering = name;
  let heard = 'no error event';
  try {
    const started = spawn('/no/such/program-of-this-test');
    started.on('error', (error) => { heard = 'error ' + error.code; });
  } catch (error) { heard = 'spawn threw ' + (error && error.code); }
  return new Promise((done) => setImmediate(() => setImmediate(() => { say(name + ': ' + heard); done(); })));
}

async function entered(name, listen) {
  await new Promise((done) => listen(() => { child(name).then(done); }));
}

(async () => {
  // An AbortSignal's timeout does not keep a process alive; this does, until the last line is said.
  const alive = setInterval(() => {}, 1000);
  // A step that never comes back is said with what was reached, rather than waited for.
  setTimeout(() => { console.log('ORDER ' + out.join(' | ') + ' | STOPPED while ' + entering); process.exit(1); }, 15000).unref();
  await binding('readFile', (cb) => fs.readFile(__filename, cb));
  await binding('stat', (cb) => fs.stat(__filename, cb));
  await binding('promises.readFile', (cb) => { fs.promises.readFile(__filename).then(cb); });
  await binding('gzip', (cb) => zlib.gzip('x', cb));
  await binding('randomBytes', (cb) => crypto.randomBytes(8, cb));
  await binding('pbkdf2', (cb) => crypto.pbkdf2('a', 'b', 1, 8, 'sha256', cb));
  await binding('lookup', (cb) => dns.lookup('localhost', cb));
  await binding('exec', (cb) => exec('node -e 0', cb));
  await binding('immediate', (cb) => setImmediate(cb));
  await binding('timeout', (cb) => setTimeout(cb, 1));
  await settle();
  await entered('abort-timeout', (run) => AbortSignal.timeout(2).addEventListener('abort', run));
  await entered('abort-now', (run) => { const controller = new AbortController(); controller.signal.addEventListener('abort', run); setTimeout(() => controller.abort(), 1); });
  await entered('message-port', (run) => { const { port1, port2 } = new MessageChannel(); port1.onmessage = () => { port1.close(); run(); }; port2.postMessage(1); });
  await entered('broadcast', (run) => { const a = new BroadcastChannel('callback-ticks'), b = new BroadcastChannel('callback-ticks'); b.onmessage = () => { a.close(); b.close(); run(); }; a.postMessage(1); });
  await entered('event-target', (run) => { const target = new EventTarget(); target.addEventListener('go', run); queueMicrotask(() => target.dispatchEvent(new Event('go'))); });
  await entered('microtask', (run) => queueMicrotask(run));
  await entered('promise', (run) => { Promise.resolve().then(run); });
  clearInterval(alive);
  console.log('ORDER ' + out.join(' | '));
})();
