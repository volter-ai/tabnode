// RSA through this engine's node:crypto (bundled from source here, the shim's own wiring and not the arithmetic
// alone) against Node's own, both directions: a key made by Node read here in each encoding, deterministic
// signatures compared byte for byte, the random ones (PSS, OAEP, PKCS1 encryption) accepted by the other side, and a
// key made here read by Node. An instrument: it prints one line per form and a count.
//   node scripts/crypto-rsa-forms.mjs        (about 2 s)
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
const { privateKey, publicKey } = real.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }), pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' });
const spki = publicKey.export({ type: 'spki', format: 'pem' }), publicPkcs1 = publicKey.export({ type: 'pkcs1', format: 'pem' });
const data = Buffer.from('the bytes that are signed');
let rows = 0, bad = 0;
const row = (name, run) => { rows += 1; let said; try { said = run(); } catch (error) { said = `THROWN ${error?.code ?? ''} ${error?.message ?? error}`; } if (said !== true) bad += 1; console.log(`${said === true ? 'ok  ' : 'FAIL'} ${name}${said === true ? '' : `: ${said}`}`); };
for (const digest of ['sha1', 'sha256', 'sha384', 'sha512']) {
  const theirs = real.sign(digest, data, pkcs8);
  row(`sign ${digest}, pkcs8 pem: Node's bytes`, () => ours.sign(digest, data, pkcs8).equals(theirs));
  row(`sign ${digest}, pkcs1 pem`, () => ours.sign(digest, data, pkcs1).equals(theirs));
  row(`verify ${digest}, spki and pkcs1 public and the private key`, () => [spki, publicPkcs1, pkcs8].every((key) => ours.verify(digest, data, key, theirs) === true) && ours.verify(digest, Buffer.from('other'), spki, theirs) === false);
}
row('createSign / createVerify RSA-SHA256', () => ours.createSign('RSA-SHA256').update(data).sign(pkcs8, 'base64') === real.createSign('RSA-SHA256').update(data).sign(pkcs8, 'base64') && ours.createVerify('RSA-SHA256').update(data).verify(spki, real.sign('sha256', data, pkcs8)));
row('a KeyObject: type, details, and each export Node writes', () => { const key = ours.createPrivateKey(pkcs8), pub = ours.createPublicKey(pkcs8); return key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength === 2048 && key.export({ type: 'pkcs8', format: 'pem' }) === pkcs8 && key.export({ type: 'pkcs1', format: 'pem' }) === pkcs1 && pub.export({ type: 'spki', format: 'pem' }) === spki && pub.export({ type: 'pkcs1', format: 'pem' }) === publicPkcs1 && ours.sign('sha256', data, key).equals(real.sign('sha256', data, pkcs8)); });
row('a DER key with its type named', () => ours.sign('sha256', data, { key: privateKey.export({ type: 'pkcs8', format: 'der' }), format: 'der', type: 'pkcs8' }).equals(real.sign('sha256', data, pkcs8)));
const pss = { padding: real.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
row('PSS made here is accepted by Node, and Node\'s here', () => real.verify('sha256', data, { key: spki, ...pss }, ours.sign('sha256', data, { key: pkcs8, ...pss })) && ours.verify('sha256', data, { key: spki, ...pss }, real.sign('sha256', data, { key: pkcs8, ...pss })));
row('OAEP both directions', () => real.privateDecrypt(pkcs8, ours.publicEncrypt(spki, Buffer.from('a secret'))).toString() === 'a secret' && ours.privateDecrypt(pkcs8, real.publicEncrypt(spki, Buffer.from('a secret'))).toString() === 'a secret');
const v15 = { padding: real.constants.RSA_PKCS1_PADDING };
row('PKCS1 encryption made here is read by Node', () => real.privateDecrypt({ key: pkcs8, ...v15 }, ours.publicEncrypt({ key: spki, ...v15 }, Buffer.from('a secret'))).toString() === 'a secret');
row('a key pair made here is read by Node and its signature verifies there', () => { const made = ours.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }); return real.verify('sha256', data, made.publicKey, ours.sign('sha256', data, made.privateKey)) && real.createPrivateKey(made.privateKey).asymmetricKeyDetails.modulusLength === 2048; });
console.log(`${bad === 0 ? 'ALL' : `${rows - bad} of`} ${rows} forms ok${bad ? `; ${bad} FAILED` : ''}`);
process.exit(bad ? 1 : 0);
