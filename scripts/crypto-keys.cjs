// Hostile, odd and value-dependent inputs to node:crypto's EC and Ed25519 paths: the cases scripts/crypto-keys-compare.mjs runs. Prints one line per case: its name and what happened
// (a short digest of the answer, or the error's code and class). Run under real Node and in a guest; compare the lines.
const crypto = require('crypto');
const out = [];
const short = (v) => { if (Buffer.isBuffer(v)) return 'buf:' + v.length + ':' + crypto.createHash('sha256').update(v).digest('hex').slice(0, 8); if (typeof v === 'string') return 'str:' + v.split('\n')[0].slice(0, 40); if (v && typeof v === 'object' && v.type) return 'key:' + v.type + ':' + v.asymmetricKeyType; return JSON.stringify(v); };
const t = (name, f) => { try { out.push(name + ' => ' + short(f())); } catch (e) { out.push(name + ' => THROWS ' + (e && e.code) + ' ' + (e && e.constructor && e.constructor.name)); } };
// Fixed keys, so both sides read the same bytes.
const EC_PKCS8 = Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420' + '11'.repeat(32) + 'a144034200' + '04' + '0217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed' + '194a7debcb97712d2dda3ca85aa8765a56f45fc758599652f2897c65306e5794', 'hex');
const ecPriv = crypto.createPrivateKey({ key: EC_PKCS8, format: 'der', type: 'pkcs8' });
const ecPub = crypto.createPublicKey(ecPriv);
const spki = ecPub.export({ type: 'spki', format: 'der' });
const sec1 = ecPriv.export({ type: 'sec1', format: 'der' });
const edPriv = crypto.createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + '22'.repeat(32), 'hex'), format: 'der', type: 'pkcs8' });
const edPub = crypto.createPublicKey(edPriv);
const edSpki = edPub.export({ type: 'spki', format: 'der' });
t('fixed ec public', () => spki); t('fixed ec sec1', () => sec1); t('fixed ed public', () => edSpki);
// P1: an encrypted export.
t('P1 export pkcs8 pem cipher+passphrase', () => { const s = ecPriv.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }); return s.split('\n')[0]; });
t('P1 export sec1 pem cipher+passphrase', () => ecPriv.export({ type: 'sec1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }).split('\n')[0]);
t('P1 export der cipher+passphrase', () => typeof ecPriv.export({ type: 'pkcs8', format: 'der', cipher: 'aes-256-cbc', passphrase: 'pw' }));
t('P1 export cipher no passphrase', () => ecPriv.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc' }).split('\n')[0]);
t('P1 export passphrase no cipher', () => ecPriv.export({ type: 'pkcs8', format: 'pem', passphrase: 'pw' }).split('\n')[0]);
t('P1 export ed cipher+passphrase', () => edPriv.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }).split('\n')[0]);
t('P1 generateKeyPairSync cipher+passphrase', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey.split('\n')[0]);
t('P1 generateKeyPairSync ed cipher+passphrase', () => crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' } }).privateKey.split('\n')[0]);
t('P1 public export with cipher', () => ecPub.export({ type: 'spki', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }).split('\n')[0]);
t('P1 jwk export with cipher', () => Object.keys(ecPriv.export({ format: 'jwk', cipher: 'aes-256-cbc', passphrase: 'pw' })).join(','));
t('secret export jwk', () => crypto.createSecretKey(Buffer.from('abc')).export({ format: 'jwk' }));
t('secret export buffer', () => crypto.createSecretKey(Buffer.from('abc')).export({ format: 'buffer' }));
t('secret export bad format', () => crypto.createSecretKey(Buffer.from('abc')).export({ format: 'pem' }));
t('private export no options', () => ecPriv.export());
// i: an encrypted key on the way in (made by OpenSSL 3: PBES2, password "pw", and a legacy Proc-Type one).
const ENC8 = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIGzMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBAO00q5qvj+TgFhUGQQ\nOfmvAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQO6VXHCyzaQ7RK91H\nHIA9igRQtW+arQDS8p9/shW6pwZhWDcbxLODuLZC5LYqA7VeHB1/MZfREAVzCwlq\nxZxGaq0T0MGxHZJTn6WZWgAcynbM+YMGCt5f5SJGFNTpmyZOCVo=\n-----END ENCRYPTED PRIVATE KEY-----\n";
const LEGACY = "-----BEGIN EC PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,83092DA2C6CE9388F36B9415B436B0E5\n\nT2Vfd3n9YDIYo7ZY7WKOgR+EsSzEISvkb8A/FT7Lzi4d+wjxvaajKOeHvZOs7hOS\nOB/N+XrexKJ5tme0LV+jimbet0Ld8MT51E1+bQdzAC3FspBwgyUt/4Oo7Wj0wAAs\nX0AVOYSPLHMibsEMLRsJPepXIaizTUb2nmCwvDlkHGg=\n-----END EC PRIVATE KEY-----\n";
t('i encrypted pkcs8 no passphrase', () => crypto.createPrivateKey(ENC8));
t('i encrypted pkcs8 with passphrase', () => crypto.createPrivateKey({ key: ENC8, passphrase: 'pw' }));
t('i legacy encrypted no passphrase', () => crypto.createPrivateKey(LEGACY));
t('i legacy encrypted with passphrase', () => crypto.createPrivateKey({ key: LEGACY, passphrase: 'pw' }));
t('i plain key with a passphrase', () => crypto.createPrivateKey({ key: ecPriv.export({ type: 'pkcs8', format: 'pem' }), passphrase: 'pw' }));
t('i encrypted pkcs8 wrong passphrase', () => crypto.createPrivateKey({ key: ENC8, passphrase: 'no' }));
t('i sign with encrypted pem', () => crypto.sign('sha256', Buffer.from('m'), ENC8).length);
// a: the caller's buffer is not the key.
t('a zeroed der after import', () => { const der = Buffer.from(sec1); const k = crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' }); der.fill(0); return k.export({ type: 'pkcs8', format: 'der' }); });
t('a zeroed pkcs8 after import', () => { const der = Buffer.from(EC_PKCS8); const k = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); der.fill(0); return k.export({ type: 'sec1', format: 'der' }); });
// b: a public point is validated.
const withPoint = (point) => Buffer.concat([spki.subarray(0, spki.length - 65 - 3), Buffer.from([0x03, point.length + 1, 0x00]), point]);
const good = spki.subarray(spki.length - 65);
t('b good point', () => crypto.createPublicKey({ key: withPoint(good), format: 'der', type: 'spki' }));
t('b point off the curve', () => { const p = Buffer.from(good); p[64] ^= 1; return crypto.createPublicKey({ key: withPoint(p), format: 'der', type: 'spki' }); });
t('b point too short', () => crypto.createPublicKey({ key: withPoint(good.subarray(0, 64)), format: 'der', type: 'spki' }));
t('b point at infinity', () => crypto.createPublicKey({ key: withPoint(Buffer.from([0])), format: 'der', type: 'spki' }));
t('b unused bits not zero', () => { const k = Buffer.from(spki); k[k.length - 66] = 1; return crypto.createPublicKey({ key: k, format: 'der', type: 'spki' }); });
t('b ed point 31 bytes', () => crypto.createPublicKey({ key: Buffer.from('302930050603' + '2b6570' + '032000' + '22'.repeat(31), 'hex'), format: 'der', type: 'spki' }));
t('b verify with off-curve key', () => { const p = Buffer.from(good); p[64] ^= 1; return crypto.verify('sha256', Buffer.from('m'), { key: withPoint(p), format: 'der', type: 'spki' }, Buffer.alloc(70)); });
// c: a private key whose stated public half is another key's.
const otherPoint = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.from(EC_PKCS8.toString('hex').replace('11'.repeat(32), '33'.repeat(32)).replace(/a144034200.*/, ''), 'hex').length ? EC_PKCS8 : EC_PKCS8, format: 'der', type: 'pkcs8' }));
t('c pkcs8 mismatched public half', () => { const k = Buffer.from(EC_PKCS8); k[k.length - 1] ^= 1; k[k.length - 2] ^= 3; return crypto.createPrivateKey({ key: k, format: 'der', type: 'pkcs8' }); });
t('c sec1 public half of another scalar', () => { const k = Buffer.from(sec1); k[8] ^= 1; return crypto.createPrivateKey({ key: k, format: 'der', type: 'sec1' }); });
t('c sign with mismatched key verifies with derived public', () => { const k = Buffer.from(sec1); k[8] ^= 1; const priv = crypto.createPrivateKey({ key: k, format: 'der', type: 'sec1' }); const sig = crypto.sign('sha256', Buffer.from('m'), priv); return crypto.verify('sha256', Buffer.from('m'), crypto.createPublicKey(priv), sig); });
t('c scalar zero', () => crypto.createPrivateKey({ key: Buffer.from(EC_PKCS8.toString('hex').replace('11'.repeat(32), '00'.repeat(32)), 'hex'), format: 'der', type: 'pkcs8' }));
t('c scalar over the order', () => crypto.createPrivateKey({ key: Buffer.from(EC_PKCS8.toString('hex').replace('11'.repeat(32), 'ff'.repeat(32)), 'hex'), format: 'der', type: 'pkcs8' }));
// d: two curves in one PKCS#8.
const P384 = '06052b81040022';
t('d pkcs8 says P-256, sec1 says P-384', () => { const inner = Buffer.concat([Buffer.from('0201010420' + '11'.repeat(32), 'hex'), Buffer.from('a007' + P384, 'hex')]); const s1 = Buffer.concat([Buffer.from([0x30, inner.length]), inner]); const body = Buffer.concat([Buffer.from('020100301306072a8648ce3d020106082a8648ce3d030107', 'hex'), Buffer.from([0x04, s1.length]), s1]); return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from([0x30, body.length]), body]), format: 'der', type: 'pkcs8' }); });
// e: the DER reader.
t('e truncated', () => crypto.createPrivateKey({ key: EC_PKCS8.subarray(0, EC_PKCS8.length - 5), format: 'der', type: 'pkcs8' }));
t('e trailing bytes after the key', () => crypto.createPrivateKey({ key: Buffer.concat([EC_PKCS8, Buffer.from([0, 0])]), format: 'der', type: 'pkcs8' }));
t('e long-form length for a short one', () => { const k = Buffer.concat([Buffer.from([0x30, 0x81, spki.length - 2]), spki.subarray(2)]); return crypto.createPublicKey({ key: k, format: 'der', type: 'spki' }); });
t('e length with a leading zero', () => { const k = Buffer.concat([Buffer.from([0x30, 0x82, 0x00, spki.length - 2]), spki.subarray(2)]); return crypto.createPublicKey({ key: k, format: 'der', type: 'spki' }); });
t('e extra element in spki', () => { const body = Buffer.concat([spki.subarray(2), Buffer.from([0x05, 0x00])]); return crypto.createPublicKey({ key: Buffer.concat([Buffer.from([0x30, body.length]), body]), format: 'der', type: 'spki' }); });
t('e extra element in sec1', () => { const body = Buffer.concat([sec1.subarray(2), Buffer.from([0x05, 0x00])]); return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from([0x30, body.length]), body]), format: 'der', type: 'sec1' }); });
t('e sec1 version 2', () => { const k = Buffer.from(sec1); k[4] = 2; return crypto.createPrivateKey({ key: k, format: 'der', type: 'sec1' }); });
t('e pkcs8 version 5', () => { const k = Buffer.from(EC_PKCS8); k[5] = 5; return crypto.createPrivateKey({ key: k, format: 'der', type: 'pkcs8' }); });
t('e not der at all', () => crypto.createPrivateKey({ key: Buffer.from('hello world'), format: 'der', type: 'pkcs8' }));
t('e empty', () => crypto.createPublicKey({ key: Buffer.alloc(0), format: 'der', type: 'spki' }));
t('e sec1 without curve, no container', () => { const body = Buffer.from('0201010420' + '11'.repeat(32), 'hex'); return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from([0x30, body.length]), body]), format: 'der', type: 'sec1' }); });
t('e pkcs8 without the public half', () => { const s1 = Buffer.from('30250201010420' + '11'.repeat(32), 'hex'); const body = Buffer.concat([Buffer.from('020100301306072a8648ce3d020106082a8648ce3d030107', 'hex'), Buffer.from([0x04, s1.length]), s1]); return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from([0x30, body.length]), body]), format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'der' }); });
t('e pem with garbage base64', () => crypto.createPublicKey('-----BEGIN PUBLIC KEY-----\n!!!!\n-----END PUBLIC KEY-----\n'));
// f: JWK.
const jwk = ecPriv.export({ format: 'jwk' }), edJwk = edPriv.export({ format: 'jwk' });
t('f good jwk', () => crypto.createPrivateKey({ key: jwk, format: 'jwk' }));
t('f x too long', () => crypto.createPublicKey({ key: { ...jwk, d: undefined, x: jwk.x + 'AAAA' }, format: 'jwk' }));
t('f x too short', () => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: 'AA', y: jwk.y }, format: 'jwk' }));
t('f d not matching x,y', () => crypto.createPrivateKey({ key: { ...jwk, d: Buffer.alloc(32, 0x33).toString('base64url') }, format: 'jwk' }));
t('f point off curve', () => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.x }, format: 'jwk' }));
t('f missing y', () => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x }, format: 'jwk' }));
t('f unknown curve', () => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-999', x: jwk.x, y: jwk.y }, format: 'jwk' }));
t('f ed d wrong length', () => crypto.createPrivateKey({ key: { ...edJwk, d: 'AAAA' }, format: 'jwk' }));
t('f ed d not matching x', () => crypto.createPrivateKey({ key: { ...edJwk, d: Buffer.alloc(32, 0x44).toString('base64url') }, format: 'jwk' }));
t('f ed x wrong length', () => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' }, format: 'jwk' }));
t('f kty missing', () => crypto.createPublicKey({ key: { crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }));
t('f not an object', () => crypto.createPublicKey({ key: 'text', format: 'jwk' }));
// g: Ed25519 strictness. Vectors from "Taming the many EdDSAs" (Chalkias, Garillot, Nikolaenko), cases 0 to 11:
// message, public key, signature. Which verify tells ZIP-215 from the strict rule.
const V = [
 ['8c93255d71dcab10e8f379c26200f3c7bd5f09d9bc3068d3ef4edeb4853022b6', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a0000000000000000000000000000000000000000000000000000000000000000'],
 ['9bd9f44f4dcc75bd531b56b2cd280b0bb38fc1cd6d1230e14861d861de092e79', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', 'f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43a5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04'],
 ['aebf3f2601a0c8c5d39cc7d8911642f740b78168218da8471772b35f9d35b9ab', 'f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa8c4bd45aecaca5b24fb97bc10ac27ac8751a7dfe1baff8b953ec9f5833ca260e'],
 ['9bd9f44f4dcc75bd531b56b2cd280b0bb38fc1cd6d1230e14861d861de092e79', 'cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d', '9046a64750444938de19f227bb80485e92b83fdb4b6506c160484c016cc1852f87909e14428a7a1d62e9f22f3d3ad7802db02eb2e688b6c52fcd6648a98bd009'],
 ['e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec4011eaccd55b53f56c', 'cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d', '160a1cb0dc9c0258cd0a7d23e94d8fa878bcb1925f2c64246b2dee1796bed5125ec6bc982a269b723e0668e540911a9a6a58921d6925e434ab10aa7940551a09'],
 ['e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec4011eaccd55b53f56c', 'cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d', '21122a84e0b5fca4052f5b1235c80a537878b38f3142356b2c2384ebad4668b7e40bc836dac0f71076f9abe3a53f9c03c1ceeeddb658d0030494ace586687405'],
 ['85e241a07d148b41e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec40', '442aad9f089ad9e14647b1ef9099a1ff4798d78589e66f28eca69c11f582a623', 'e96f66be976d82e60150baecff9906684aebb1ef181f67a7189ac78ea23b6c0e547f7690a0e2ddcd04d87dbc3490dc19b3b3052f7ff0538cb68afb369ba3a514'],
 ['85e241a07d148b41e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec40', '442aad9f089ad9e14647b1ef9099a1ff4798d78589e66f28eca69c11f582a623', '8ce5b96c8f26d0ab6c47958c9e68b937104cd36e13c33566acd2fe8d38aa19427e71f98a473474f2f13f06f97c20d58cc3f54b8bd0d272f42b695dd7e89a8c22'],
 ['9bedc267423725d473888631ebf45988bad3db83851ee85c85e241a07d148b41', 'f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff03be9678ac102edcd92b0210bb34d7428d12ffc5df5f37e359941266a4e35f0f'],
 ['9bedc267423725d473888631ebf45988bad3db83851ee85c85e241a07d148b41', 'f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffca8c5b64cd208982aa38d4936621a4775aa233aa0505711d8fdcfdaa943d4908'],
 ['e96b7021eb39c1a163b6da4e3093dcd3f21387da4cc4572be588fafae23c155b', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'a9d55260f765261eb9b84e106f665e00b867287a761990d7135963ee0a7d59dca5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04'],
 ['39a591f5321bbe07fd5a23dc2f39d025d74526615746727ceefd6e82ae65c06f', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'a9d55260f765261eb9b84e106f665e00b867287a761990d7135963ee0a7d59dca5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04'],
];
V.forEach(([m, p, s], i) => t('g eddsa vector ' + i, () => crypto.verify(null, Buffer.from(m, 'hex'), { key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(p, 'hex')]), format: 'der', type: 'spki' }, Buffer.from(s, 'hex'))));
t('g ed sign is deterministic', () => crypto.sign(null, Buffer.from('m'), edPriv));
t('g ed signature of wrong length', () => crypto.verify(null, Buffer.from('m'), edPub, Buffer.alloc(63)));
// h: digests named for a signature.
for (const name of ['sha256', 'SHA256', 'sha512-256', 'sha512-224', 'RSA-SHA256', 'sha3-256', 'sha1', 'md5', 'nope', 'sha512']) t('h sign with ' + name, () => crypto.verify(name, Buffer.from('m'), ecPub, crypto.sign(name, Buffer.from('m'), ecPriv)) + ':' + crypto.createSign(name).update('m').sign({ key: ecPriv, dsaEncoding: 'ieee-p1363' }).length);
t('h hash sha512-256', () => crypto.createHash('sha512-256').update('m').digest());
// The class: options that must be read or refused.
const msg = Buffer.from('m');
t('opt dsaEncoding ieee', () => crypto.sign('sha256', msg, { key: ecPriv, dsaEncoding: 'ieee-p1363' }).length);
t('opt dsaEncoding bad', () => crypto.sign('sha256', msg, { key: ecPriv, dsaEncoding: 'raw' }).length);
t('opt padding on an ec key', () => crypto.sign('sha256', msg, { key: ecPriv, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }).length > 0);
t('opt saltLength on an ec key', () => crypto.sign('sha256', msg, { key: ecPriv, saltLength: 20 }).length > 0);
t('opt padding on verify', () => crypto.verify('sha256', msg, { key: ecPub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, crypto.sign('sha256', msg, ecPriv)));
t('opt paramEncoding explicit', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', paramEncoding: 'explicit' }).publicKey.export({ type: 'spki', format: 'der' }).length);
t('opt paramEncoding named', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', paramEncoding: 'named' }).publicKey.export({ type: 'spki', format: 'der' }).length);
t('opt paramEncoding bad', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', paramEncoding: 'weird' }));
t('opt namedCurve unknown', () => crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.asymmetricKeyDetails.namedCurve);
t('opt publicKeyEncoding type pkcs1 on ec', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }));
t('opt privateKeyEncoding type pkcs1 on ec', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }));
t('opt import der key as hex string with encoding', () => crypto.createPublicKey({ key: spki.toString('hex'), format: 'der', type: 'spki', encoding: 'hex' }));
t('opt import pem type ignored', () => crypto.createPublicKey({ key: ecPub.export({ type: 'spki', format: 'pem' }), format: 'pem', type: 'pkcs1' }));
t('opt import der wrong type', () => crypto.createPublicKey({ key: spki, format: 'der', type: 'pkcs1' }));
t('opt import der no type', () => crypto.createPrivateKey({ key: EC_PKCS8, format: 'der' }));
t('opt createHash outputLength', () => crypto.createHash('sha256', { outputLength: 16 }).update('m').digest());
t('opt export jwk public', () => ecPub.export({ format: 'jwk' }));
t('opt export bad format', () => ecPub.export({ type: 'spki', format: 'raw' }));
t('opt sign with public key', () => crypto.sign('sha256', msg, ecPub));
t('opt createPrivateKey from public pem', () => crypto.createPrivateKey(ecPub.export({ type: 'spki', format: 'pem' })));
// v: encodings whose shape depends on the key's VALUE, which a correct tool writes for some keys and not others.
const KX = {"kty": "EC", "x": "AIhsmySd4qcPYjiO6QSoWLTsoJG8A0MEBI3o2UFgrrc", "y": "Vc0ahvul83QL12v4gOrQhRJboTh3j_ToHBQLPDTOLsw", "crv": "P-256", "d": "gZ0MIYwt3bSDyVEy_u02uifmB-Y9yaoqS56WEk_zS5w"}, KD = {"kty": "EC", "x": "MpiblyAPoZso6eCUewKGdFjQH4BhYSJSodCwMb5FA28", "y": "qSc3q17US9yW5lR20msSXnKNx2z02fE7rhhAxW3kFJI", "crv": "P-256", "d": "AO6aHwtY7rtPPI9yIsS88FrOAcnAxCLw_FegfABJIak"}, ECPARAM = "-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIAQM8e8ghOqK3hgrDd3yGToYFEx6FvsyXhRK5+oHkxi0oAoGCCqGSM49\nAwEHoUQDQgAEoss8k9akGpWJWBIadOWm6EeCCmfLNSLsvVBR22Fjh5unlRSnHq2n\nT8zEq52LWwPFXJrBngJiL4TxPrtQrCXOrQ==\n-----END EC PRIVATE KEY-----\n";
const strip = (b64) => Buffer.from(b64, 'base64url').subarray(1).toString('base64url');
const widen = (b64) => Buffer.concat([Buffer.from([0]), Buffer.from(b64, 'base64url')]).toString('base64url');
const std = (b64) => Buffer.from(b64, 'base64url').toString('base64');
t('v jwk x without its leading zero, public', () => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: strip(KX.x), y: KX.y }, format: 'jwk' }).export({ format: 'jwk' }));
t('v jwk x without its leading zero, private', () => crypto.createPrivateKey({ key: { ...KX, x: strip(KX.x) }, format: 'jwk' }).export({ type: 'pkcs8', format: 'der' }));
t('v jwk d without its leading zero', () => crypto.createPrivateKey({ key: { ...KD, d: strip(KD.d) }, format: 'jwk' }).export({ format: 'jwk' }));
t('v jwk x with one more leading zero', () => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: widen(KX.x), y: KX.y }, format: 'jwk' }).export({ format: 'jwk' }));
t('v jwk d with one more leading zero', () => crypto.createPrivateKey({ key: { ...KD, d: widen(KD.d) }, format: 'jwk' }).export({ format: 'jwk' }));
t('v jwk in the standard alphabet with padding', () => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: std(KX.x), y: std(KX.y) }, format: 'jwk' }).export({ format: 'jwk' }));
t('v jwk x one byte only', () => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: 'AQ', y: KX.y }, format: 'jwk' }));
const kdPriv = crypto.createPrivateKey({ key: KD, format: 'jwk' }), kdSpki = crypto.createPublicKey(kdPriv).export({ type: 'spki', format: 'der' });
const kdPoint = kdSpki.subarray(kdSpki.length - 65);
const compressedSpki = Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), Buffer.from([2 | (kdPoint[64] & 1)]), kdPoint.subarray(1, 33)]);
t('v spki with a compressed point', () => crypto.createPublicKey({ key: compressedSpki, format: 'der', type: 'spki' }));
t('v compressed key exports as it was read', () => crypto.createPublicKey({ key: compressedSpki, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'der' }));
t('v compressed key as jwk', () => crypto.createPublicKey({ key: compressedSpki, format: 'der', type: 'spki' }).export({ format: 'jwk' }));
t('v compressed key verifies', () => crypto.verify('sha256', Buffer.from('m'), { key: compressedSpki, format: 'der', type: 'spki' }, crypto.sign('sha256', Buffer.from('m'), kdPriv)));
t('v compressed key equals the uncompressed', () => crypto.createPublicKey({ key: compressedSpki, format: 'der', type: 'spki' }).equals(crypto.createPublicKey(kdPriv)));
t('v compressed with the other parity is another key', () => { const c = Buffer.from(compressedSpki); c[26] ^= 1; return crypto.createPublicKey({ key: c, format: 'der', type: 'spki' }).equals(crypto.createPublicKey(kdPriv)); });
t('v compressed x not on the curve', () => { const c = Buffer.from(compressedSpki); c.fill(0xff, 27); return crypto.createPublicKey({ key: c, format: 'der', type: 'spki' }); });
t('v hybrid point', () => { const h = Buffer.concat([kdSpki.subarray(0, kdSpki.length - 65), Buffer.from([6 | (kdPoint[64] & 1)]), kdPoint.subarray(1)]); return crypto.createPublicKey({ key: h, format: 'der', type: 'spki' }); });
t('v ecparam -genkey, private', () => crypto.createPrivateKey(ECPARAM).export({ type: 'pkcs8', format: 'der' }));
t('v ecparam -genkey, public', () => crypto.createPublicKey(ECPARAM).export({ type: 'spki', format: 'der' }));
t('v ecparam -genkey, sign and verify', () => crypto.verify('sha256', Buffer.from('m'), ECPARAM, crypto.sign('sha256', Buffer.from('m'), ECPARAM)));
t('v two keys in one text', () => crypto.createPrivateKey(kdPriv.export({ type: 'pkcs8', format: 'pem' }) + ecPriv.export({ type: 'pkcs8', format: 'pem' })).equals(kdPriv));
t('v notes before the block', () => crypto.createPrivateKey('some notes\n' + kdPriv.export({ type: 'sec1', format: 'pem' })).equals(kdPriv));
t('v sec1 private value without its leading zero', () => { const d = Buffer.from(KD.d, 'base64url').subarray(1); const body = Buffer.concat([Buffer.from('020101041f', 'hex'), d, Buffer.from('a00a06082a8648ce3d030107', 'hex')]); return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from([0x30, body.length]), body]), format: 'der', type: 'sec1' }).equals(kdPriv); });
t('v sec1 private value with one more leading zero', () => { const d = Buffer.concat([Buffer.from([0]), Buffer.from(KD.d, 'base64url')]); const body = Buffer.concat([Buffer.from('0201010421', 'hex'), d, Buffer.from('a00a06082a8648ce3d030107', 'hex')]); return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from([0x30, body.length]), body]), format: 'der', type: 'sec1' }).equals(kdPriv); });
console.log('KX ' + JSON.stringify(out));
