// Ed25519 at volume: this engine's node:crypto (bundled from source here) against Node's own, both directions, the
// accepting and the refusing side, with RFC 8032's first three vectors. Verification here is written out (crypto-ec.ts
// verifyEd25519, OpenSSL's rule), so it is compared at volume and not only on chosen vectors. An instrument.
//   node scripts/crypto-ed25519-volume.mjs [keys, default 3000]        (about 15 s for 3,000)
import * as fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import real from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { build } = await import(pathToFileURL(resolve(root, 'node_modules/esbuild/lib/main.js')).href);
const raw = { name: 'raw', setup(b) {
  b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'raw' }));
  b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf8'), loader: 'text' }));
} };
const bundle = resolve(fs.mkdtempSync(resolve(tmpdir(), 'crypto-shim-')), 'crypto.mjs');
await build({ entryPoints: [resolve(root, 'src/shims/crypto.ts')], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error', plugins: [raw], external: ['*.node'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
const ours = (await import(pathToFileURL(bundle).href)).createCryptoModule(createRequire(import.meta.url));
const N = Number(process.argv[2] || 3000);
let checks = 0, bad = 0; const failed = [];
const check = (name, got, want) => { checks += 1; if (got !== want) { bad += 1; if (failed.length < 8) failed.push(`${name}: got ${got} want ${want}`); } };
// RFC 8032 section 7.1, tests 1, 2 and 3: secret seed, public key, message, signature.
const RFC = [
  ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '', 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
  ['4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72', '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
  ['c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7', 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82', '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
];
const pkcs8 = (seed) => Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const spki = (point) => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), point]);
for (const [index, [seed, point, message, signature]] of RFC.entries()) {
  for (const [who, lib] of [['node', real], ['ours', ours]]) {
    const key = lib.createPrivateKey({ key: pkcs8(Buffer.from(seed, 'hex')), format: 'der', type: 'pkcs8' });
    check(`rfc ${index + 1} ${who} public key`, lib.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('hex'), spki(Buffer.from(point, 'hex')).toString('hex'));
    check(`rfc ${index + 1} ${who} signature`, lib.sign(null, Buffer.from(message, 'hex'), key).toString('hex'), signature);
    check(`rfc ${index + 1} ${who} verifies`, lib.verify(null, Buffer.from(message, 'hex'), { key: spki(Buffer.from(point, 'hex')), format: 'der', type: 'spki' }, Buffer.from(signature, 'hex')), true);
  }
}
let accepted = 0, refused = 0;
for (let i = 0; i < N; i += 1) {
  const makes = i % 2 ? real : ours, other = i % 2 ? ours : real;
  const pair = makes.generateKeyPairSync('ed25519');
  const seedDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' }), pointDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  const message = real.randomBytes(real.randomInt(0, 300));
  const theirs = { priv: other.createPrivateKey({ key: seedDer, format: 'der', type: 'pkcs8' }), pub: other.createPublicKey({ key: pointDer, format: 'der', type: 'spki' }) };
  const a = makes.sign(null, message, pair.privateKey), b = other.sign(null, message, theirs.priv);
  check('one signature for one key and message', a.toString('hex'), b.toString('hex'));
  check('made here, verified there', other.verify(null, message, theirs.pub, a), true);
  check('made there, verified here', makes.verify(null, message, pair.publicKey, b), true);
  accepted += 2;
  // The refusing side: one bit of the signature, of the message, or of the key; both must give the same answer.
  const flipped = Buffer.from(a); flipped[real.randomInt(0, 64)] ^= 1 << real.randomInt(0, 8);
  const answers = [real, ours].map((lib) => { try { return lib.verify(null, message, { key: pointDer, format: 'der', type: 'spki' }, flipped); } catch (e) { return 'throws'; } });
  check('a flipped signature bit', answers[1], answers[0]); if (answers[0] === false) refused += 1;
  const changed = Buffer.concat([message, Buffer.from([1])]);
  check('another message', ours.verify(null, changed, { key: pointDer, format: 'der', type: 'spki' }, a), real.verify(null, changed, { key: pointDer, format: 'der', type: 'spki' }, a));
  const otherKey = Buffer.from(pointDer); otherKey[12 + real.randomInt(0, 32)] ^= 1 << real.randomInt(0, 8);
  const keyAnswers = [real, ours].map((lib) => { try { return lib.verify(null, message, { key: otherKey, format: 'der', type: 'spki' }, a); } catch (e) { return 'throws'; } });
  check('a flipped key bit', keyAnswers[1], keyAnswers[0]);
}
console.log(`Ed25519 against ${process.version}: ${N} keys and messages, ${checks} checks, ${bad} failed; ${accepted} signatures accepted across the two, ${refused} flipped signatures refused by Node`);
for (const line of failed) console.log('  FAIL ' + line);
if (bad) process.exit(1);
