// node:crypto's EC and Ed25519 keys against real Node, on inputs a comparison of well-formed keys never has:
// truncated and non-minimal DER, points off their curve, halves that are not one key, encrypted keys in and out,
// encodings whose shape depends on the key's value (a JWK member without its leading zero, a compressed point,
// the two blocks `openssl ecparam -genkey` writes), the twelve EdDSA vectors that tell verification rules apart.
// An instrument: it runs scripts/crypto-keys.cjs under this Node and in a guest of the built engine, and prints
// how the answers compare. Nothing here is a verdict on its own; CHANGELOG's v0.9.0 states the differences kept.
//   npm run build:lib && node scripts/crypto-keys-compare.mjs        (Node 24.21.0)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = resolve(root, 'scripts/crypto-keys.cjs');
const parse = (text) => { const line = String(text).split('\n').find((l) => l.startsWith('KX ')); if (!line) throw new Error('the case script printed no result: ' + String(text).slice(0, 300)); return new Map(JSON.parse(line.slice(3)).map((entry) => { const at = entry.indexOf(' => '); return [entry.slice(0, at), entry.slice(at + 4)]; })); };
const reference = spawnSync(process.execPath, [cases], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const node = parse(reference.stdout);
const hostLog = console.log.bind(console), hostExit = process.exit.bind(process);
let said = '';
console.log = (...parts) => { const text = parts.map(String).join(' '); if (text.includes('KX ')) said = text.slice(text.indexOf('KX ')); };
console.error = () => {}; console.warn = () => {};
const { createContainer } = await import(pathToFileURL(resolve(root, 'dist/index.mjs')).href);
if (typeof globalThis.window === 'undefined') globalThis.window = { navigator: { serviceWorker: {} } };
const container = createContainer();
container.vfs.mkdirSync('/app', { recursive: true });
container.vfs.writeFileSync('/app/cases.cjs', readFileSync(cases, 'utf8'));
const run = await container.run('node /app/cases.cjs', { cwd: '/app', onStdout: (text) => console.log(String(text)) });
const guest = parse(said || run.stdout);
const same = [], bothRefuse = [], notCarried = [], stricter = [], other = [];
for (const [name, want] of node) {
  const got = guest.get(name);
  if (got === want) same.push(name);
  else if (want.startsWith('THROWS') && String(got).startsWith('THROWS')) bothRefuse.push(name);
  else if (!want.startsWith('THROWS') && String(got).includes('ERR_CRYPTO_UNSUPPORTED_OPERATION')) notCarried.push(name);
  else if (!want.startsWith('THROWS') && String(got).startsWith('THROWS')) stricter.push(name);
  else other.push(`${name}: Node ${want.slice(0, 70)} | guest ${String(got).slice(0, 70)}`);
}
hostLog(`node:crypto keys against ${process.version}: ${node.size} cases; ${same.length} identical; ${bothRefuse.length} both refuse (other codes); ${notCarried.length} Node does, refused here as not carried; ${stricter.length} Node accepts, refused here; ${other.length} other`);
hostLog('  not carried: ' + notCarried.join('; '));
hostLog('  refused here, accepted by Node: ' + stricter.join('; '));
for (const line of other) hostLog('  OTHER ' + line);
// An answer that differs with neither side refusing, or one this engine gives and Node refuses, is a defect.
hostExit(other.length ? 1 : 0);
