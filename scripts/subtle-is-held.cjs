// WebCrypto's asynchronous calls hold a process while they are outstanding, whoever makes them, and `crypto` and
// `crypto.subtle` stay the objects a program can compare and call. Under Node and as a guest of the built engine the
// lines are the same, except `held` (the engine's count of outstanding host work; Node has no such name).
const nodeCrypto = require('crypto');
const counted = () => { const work = globalThis.__browserRuntimeHeldWork; return work ? work.count : 'n/a'; };
const out = [];
(async () => {
  out.push(`identity: crypto twice ${crypto === globalThis.crypto} subtle twice ${crypto.subtle === crypto.subtle} webcrypto is the global ${nodeCrypto.webcrypto === crypto} its subtle ${nodeCrypto.webcrypto.subtle === crypto.subtle} node:crypto's subtle ${nodeCrypto.subtle === crypto.subtle}`);
  out.push(`method: name ${crypto.subtle.digest.name} length ${crypto.subtle.digest.length} same twice ${crypto.subtle.digest === crypto.subtle.digest} on the prototype ${Object.getPrototypeOf(crypto.subtle).digest === crypto.subtle.digest}`);
  const before = counted();
  const digest = crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
  const during = counted();
  const bytes = new Uint8Array(await digest);
  out.push(`digest: ${Buffer.from(bytes).toString('hex').slice(0, 16)} a promise ${digest instanceof Promise}`);
  out.push(`held: before ${before === 'n/a' ? before : 0} during ${during === 'n/a' ? during : during - before} after ${during === 'n/a' ? during : counted() - before}`);
  // A call that is refused, later or at once, holds nothing afterwards; the refusal is the platform's own.
  const refused = await crypto.subtle.digest('NO-SUCH-HASH', new Uint8Array(1)).then(() => 'answered', (error) => 'rejected ' + error.name);
  out.push(`refused: ${refused} held after ${counted() === 'n/a' ? 'n/a' : counted() - before}`);
  const detached = crypto.subtle.digest; let wrongReceiver;
  try { wrongReceiver = await detached('SHA-256', new Uint8Array(1)).then(() => 'answered', (error) => 'rejected ' + error.name); } catch (error) { wrongReceiver = 'threw ' + error.name; }
  out.push(`wrong receiver: ${wrongReceiver} held after ${counted() === 'n/a' ? 'n/a' : counted() - before}`);
  // node:crypto's own asynchronous calls pass the same door where they are answered by WebCrypto: the most held at
  // any turn until the callback is said for each (0 where the engine answers the call itself).
  const most = async (start) => {
    let done = false, seen = 0, answer;
    start((error, value) => { answer = error ? 'error ' + (error.code || error.name) : value; done = true; });
    while (!done) { if (counted() !== 'n/a') seen = Math.max(seen, counted() - before); await new Promise((turn) => setImmediate(turn)); }
    return `${answer} held at most ${counted() === 'n/a' ? 'n/a' : seen} after ${counted() === 'n/a' ? 'n/a' : counted() - before}`;
  };
  out.push('generateKeyPair rsa: ' + await most((cb) => nodeCrypto.generateKeyPair('rsa', { modulusLength: 2048 }, (error, publicKey) => cb(error, publicKey && publicKey.type))));
  out.push('generateKeyPair ec: ' + await most((cb) => nodeCrypto.generateKeyPair('ec', { namedCurve: 'P-256' }, (error, publicKey) => cb(error, publicKey && publicKey.type))));
  console.log('ORDER ' + out.join(' | '));
})();
