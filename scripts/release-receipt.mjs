// Retained-output publication: substrate ADR-0102/0214, V1-08. No build or version selection.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [action, ...extra] = process.argv.slice(2);
if (!['publish', 'verify', 'checkpoint'].includes(action) || extra.length) throw new Error('Use release.sh publish|verify|checkpoint; no build, version bump or tag runs here.');
const required = name => {
  if (!process.env[name]?.trim()) throw new Error('Set ' + name + ' to the exact retained release input.');
  return process.env[name];
};
const root = resolve(required('RELEASE_ARCHIVES'));
const source = required('RELEASE_SOURCE');
let publishHead = required('RELEASE_PUBLISH_HEAD');
const registry = new URL(required('RELEASE_REGISTRY'));
if (!/^[a-f0-9]{40}$/.test(source) || !/^[a-f0-9]{40}$/.test(publishHead)) throw new Error('Source and publish head must be full immutable commit IDs.');
if (registry.protocol !== 'https:' || registry.username || registry.password || registry.search || registry.hash) throw new Error('Select an HTTPS registry without embedded credentials.');
const authorizationReference = required('RELEASE_AUTHORIZATION');
const keysSweepReference = required('RELEASE_KEYS_SWEEP');
const distTag = required('RELEASE_DIST_TAG');
if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(distTag)) throw new Error('Select the authorized npm distribution tag explicitly.');
const file = join(root, 'receipt.json');
const rank = { prepared: 0, uploading: 1, unknown: 2, accepted: 3, 'already-published': 3, verified: 4 };
const now = () => new Date().toISOString();
let sequence = 0, checkpointUncertain = false;
const deadline = action === 'verify' ? Date.now() + 9000 : undefined;
const run = (command, args, options = {}) => {
  const timeout = deadline ? Math.max(1, deadline - Date.now()) : 9000;
  if (deadline && Date.now() >= deadline) throw new Error('Verification invocation budget ended; retained states remain pending.');
  return execFileSync(command, command === 'git' ? ['-c', 'core.hooksPath=/dev/null', ...args] : args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, ...options });
};
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const read = () => {
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('The retained receipt must be a regular file.');
  return JSON.parse(readFileSync(file, 'utf8'));
};
function durable(path, bytes, exclusive = false) {
  const temporary = exclusive ? path : path + '.' + process.pid + '.' + sequence++ + '.partial';
  const fd = openSync(temporary, 'wx', 0o600);
  let failed = false, primary;
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  catch (cause) { failed = true; primary = cause; }
  try { closeSync(fd); }
  catch (cause) { if (failed) throw new AggregateError([primary, cause], 'Receipt write and close failed'); throw cause; }
  if (failed) throw primary;
  if (!exclusive) renameSync(temporary, path);
  const directory = openSync(root, 'r');
  failed = false;
  try { fsyncSync(directory); }
  catch (cause) { failed = true; primary = cause; }
  try { closeSync(directory); }
  catch (cause) { if (failed) throw new AggregateError([primary, cause], 'Receipt directory flush and close failed'); throw cause; }
  if (failed) throw primary;
}
const save = receipt => durable(file, JSON.stringify(receipt, null, 2) + '\n');
function archive(receipt) {
  if (receipt.version !== 1 || receipt.source !== source || !/^\d+$/.test(receipt.run)
    || !Array.isArray(receipt.packages) || receipt.packages.length !== 1) throw new Error('Expected the retained version-1 engine receipt for this exact reviewed source.');
  const pkg = receipt.packages[0];
  if (pkg.name !== '@volter/tabnode' || !Object.hasOwn(rank, pkg.status)
    || typeof pkg.version !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/.test(pkg.archive)
    || !lstatSync(join(root, pkg.archive)).isFile() || lstatSync(join(root, pkg.archive)).isSymbolicLink()) throw new Error('Invalid retained engine archive.');
  const bytes = readFileSync(join(root, pkg.archive));
  if (integrity(bytes) !== pkg.integrity) throw new Error('Retained archive identity changed.');
  // Inspect the same bytes just authenticated, rather than reopening an input.
  const packed = JSON.parse(run('tar', ['-xzOf', '-', 'package/package.json'], { input: bytes }));
  const selected = JSON.parse(run('git', ['show', source + ':package.json']));
  if (packed.name !== pkg.name || packed.version !== pkg.version || selected.name !== pkg.name || selected.version !== pkg.version) throw new Error('Archive/source package identity differs.');
  for (const field of ['exports', 'types', 'dependencies', 'peerDependencies']) {
    if (JSON.stringify(packed[field]) !== JSON.stringify(selected[field])) throw new Error('Packed public metadata differs from reviewed source: ' + field);
  }
  const members = new Set(run('tar', ['-tzf', '-'], { input: bytes }).trim().split('\n'));
  const exported = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(exported) : [];
  const requiredMembers = ['dist/surface.json', 'THIRD-PARTY-NOTICES.md', ...exported(packed.exports), packed.types];
  if (requiredMembers.some(path => typeof path !== 'string' || !members.has('package/' + path.replace(/^\.\//, '')))) throw new Error('Archive lacks its surface, notices or declared entrypoint files; prepare another exact candidate.');
  for (const [key, value] of Object.entries({ registry: registry.href, distTag, authorizationReference, keysSweepReference })) {
    if (receipt[key] !== undefined && receipt[key] !== value) throw new Error('Retained release reference changed: ' + key);
    receipt[key] = value;
  }
  return { pkg, bytes };
}
function sameIdentity(previous, receipt) {
  return previous.version === 1 && previous.source === receipt.source && previous.run === receipt.run
    && previous.packages?.length === 1 && previous.packages[0].name === receipt.packages[0].name
    && previous.packages[0].version === receipt.packages[0].version && previous.packages[0].archive === receipt.packages[0].archive
    && previous.packages[0].integrity === receipt.packages[0].integrity
    && (previous.registry === undefined || previous.registry === registry.href)
    && (previous.distTag === undefined || previous.distTag === distTag)
    && (previous.authorizationReference === undefined || previous.authorizationReference === authorizationReference)
    && (previous.keysSweepReference === undefined || previous.keysSweepReference === keysSweepReference);
}
function mergeReceipt(previous, receipt) {
  if (!sameIdentity(previous, receipt) || !Object.hasOwn(rank, previous.packages[0].status)) throw new Error('Publication checkpoint identity differs.');
  const old = previous.packages[0], pkg = receipt.packages[0];
  if (rank[old.status] > rank[pkg.status]) {
    const observation = pkg.lastAvailabilityAttempt;
    Object.assign(pkg, old);
    if (observation) pkg.lastAvailabilityAttempt = observation;
  }
  if (old.acceptedAt && !pkg.acceptedAt) pkg.acceptedAt = old.acceptedAt;
}
function snapshot() {
  const remote = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/publish']).trim();
  if (remote !== publishHead + '\trefs/heads/publish') throw new Error('Publish head moved or is unknown; retain this attempt and select its exact head explicitly.');
  run('git', ['merge-base', '--is-ancestor', source, publishHead]);
  const changes = run('git', ['diff', '--name-only', source, publishHead]).trim().split('\n').filter(Boolean);
  if (changes.some(path => !/^\.github\/releases\/\d+\.json$/.test(path))) throw new Error('Publish carries source other than the reviewed build; receipt commits cannot restamp it.');
  return publishHead;
}
const recorded = (head, name) => JSON.parse(run('git', ['show', head + ':.github/releases/' + name + '.json']));
function checkpoint() {
  if (checkpointUncertain) throw new Error('A checkpoint push outcome is unknown; do not retry it automatically.');
  const receipt = read(); archive(receipt);
  const parent = snapshot(), relative = '.github/releases/' + receipt.run + '.json';
  if (run('git', ['ls-tree', '--name-only', parent, '--', relative]).trim()) mergeReceipt(recorded(parent, receipt.run), receipt);
  save(receipt);
  // A private index changes only the receipt on the exact parent, without
  // checking out, rebuilding or rebasing any source.
  const index = join(root, 'checkpoint-' + process.pid + '-' + sequence++ + '.index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  run('git', ['read-tree', parent], { env });
  const body = readFileSync(file);
  const blob = run('git', ['hash-object', '-w', '--stdin'], { input: body }).trim();
  run('git', ['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + relative], { env });
  const tree = run('git', ['write-tree'], { env }).trim();
  if (tree === run('git', ['rev-parse', parent + '^{tree}']).trim()) return;
  const commit = run('git', ['commit-tree', tree, '-p', parent, '-m', 'VO-3806 t_757ceb01 Articles 6/8/9: record retained engine publication ' + receipt.run]).trim();
  const attempt = join(root, 'checkpoint-' + commit + '.json');
  const outcome = { parent, commit, receiptIntegrity: integrity(body), status: 'unknown', startedAt: now() };
  durable(attempt, JSON.stringify(outcome, null, 2) + '\n', true);
  checkpointUncertain = true;
  // The commit is a child of the expected head. The lease rejects every
  // concurrent change; one failed/uncertain push is never retried here.
  run('git', ['push', '--force-with-lease=refs/heads/publish:' + parent, 'origin', commit + ':refs/heads/publish']);
  publishHead = commit;
  checkpointUncertain = false;
  outcome.status = 'confirmed'; outcome.confirmedAt = now();
  durable(attempt, JSON.stringify(outcome, null, 2) + '\n');
  process.stdout.write('Publication checkpoint ' + commit + '\n');
}
function registryArchive(pkg, suffix) {
  const destination = mkdtempSync(join(root, pkg.archive + suffix));
  const packed = JSON.parse(run('npm', ['pack', pkg.name + '@' + pkg.version, '--ignore-scripts', '--json', '--registry', registry.href, '--prefer-online', '--fetch-retries=0', '--fetch-timeout=7000', '--pack-destination', destination]))[0];
  if (packed.name !== pkg.name || packed.version !== pkg.version || !/^[A-Za-z0-9._-]+\.tgz$/.test(packed.filename)
    || !lstatSync(join(destination, packed.filename)).isFile() || lstatSync(join(destination, packed.filename)).isSymbolicLink()
    || integrity(readFileSync(join(destination, packed.filename))) !== pkg.integrity) throw new Error('Registry archive conflicts with retained bytes.');
}
function explicitAbsence(pkg) {
  try {
    const dist = JSON.parse(run('npm', ['view', pkg.name + '@' + pkg.version, 'dist', '--json', '--registry', registry.href, '--prefer-online', '--fetch-retries=0', '--fetch-timeout=7000']));
    if (!dist?.tarball) throw new Error('Registry returned no archive identity.');
    return false;
  } catch (cause) {
    let response;
    try { response = JSON.parse(String(cause.stdout ?? '')); } catch { /* Unknown is not absent. */ }
    if (['E404', 'ETARGET'].includes(response?.error?.code)) return true;
    throw cause;
  }
}
function publicationRecords(head, pkg) {
  return run('git', ['ls-tree', '-r', '--name-only', head, '--', '.github/releases']).trim().split('\n').filter(path => path.endsWith('.json')).flatMap(path => {
    const previous = JSON.parse(run('git', ['show', head + ':' + path]));
    if (previous.registry !== undefined && previous.registry !== registry.href) return [];
    return (previous.packages ?? []).filter(row => row.name === pkg.name && row.version === pkg.version).map(row => ({ ...row, run: previous.run, source: previous.source, registryKnown: previous.registry === registry.href }));
  });
}
function publish() {
  const receipt = read(); const { pkg, bytes } = archive(receipt);
  const head = snapshot();
  const relative = '.github/releases/' + receipt.run + '.json';
  if (!run('git', ['ls-tree', '--name-only', head, '--', relative]).trim()) throw new Error('Checkpoint the prepared receipt on publish before uploading.');
  mergeReceipt(recorded(head, receipt.run), receipt); save(receipt);
  if (pkg.status !== 'prepared') throw new Error('This release already has an attempted or completed upload; use verify, never upload it again.');
  const history = publicationRecords(head, pkg);
  if (history.some(old => !Object.hasOwn(rank, old.status) || !/^[a-f0-9]{40}$/.test(old.source) || !/^\d+$/.test(old.run))) throw new Error('An earlier publication record has unknown identity or outcome.');
  if (history.some(old => old.integrity !== pkg.integrity)) throw new Error('Another receipt reserves this version for different bytes.');
  const accepted = history.find(old => old.registryKnown && ['accepted', 'already-published', 'verified'].includes(old.status)
    && (old.acceptedAt || (old.publication?.integrity === pkg.integrity && ['accepted-receipt', 'registry-archive'].includes(old.publication.basis))));
  if (accepted || !explicitAbsence(pkg)) {
    if (!accepted) registryArchive(pkg, '.existing-');
    pkg.status = 'already-published'; pkg.alreadyPublishedAt = now();
    pkg.publication = accepted ? { basis: 'accepted-receipt', run: accepted.run, source: accepted.source, integrity: pkg.integrity } : { basis: 'registry-archive', integrity: pkg.integrity };
    if (accepted?.acceptedAt) pkg.acceptedAt = accepted.acceptedAt;
    save(receipt); return;
  }
  if (history.some(old => ['uploading', 'unknown'].includes(old.status))) throw new Error('An earlier upload outcome for this version remains unknown; explicit absence does not authorize another upload.');
  const staging = mkdtempSync(join(root, 'upload-' + receipt.run + '-'));
  const upload = join(staging, pkg.archive);
  writeFileSync(upload, bytes, { flag: 'wx', mode: 0o400 });
  if (integrity(readFileSync(upload)) !== pkg.integrity) throw new Error('Upload snapshot differs from retained archive.');
  pkg.status = 'uploading'; pkg.uploadStartedAt = now(); pkg.uploadArchive = upload;
  save(receipt); checkpoint();
  try {
    run('npm', ['publish', upload, '--ignore-scripts', '--provenance=false', '--access', 'public', '--tag', distTag, '--registry', registry.href, '--fetch-retries=0', '--fetch-timeout=7000'], { stdio: 'inherit' });
    if (integrity(readFileSync(upload)) !== pkg.integrity) throw new Error('The original upload snapshot changed; upload outcome remains unknown.');
  }
  catch (cause) {
    pkg.status = 'unknown'; pkg.unknownSince = now();
    try { save(receipt); } catch (saving) { throw new AggregateError([cause, saving], 'Upload outcome and receipt save failed'); }
    throw cause;
  }
  pkg.status = 'accepted'; pkg.acceptedAt = now(); save(receipt);
}
function verify() {
  const receipt = read(); const { pkg } = archive(receipt); const head = snapshot();
  const relative = '.github/releases/' + receipt.run + '.json';
  if (run('git', ['ls-tree', '--name-only', head, '--', relative]).trim()) mergeReceipt(recorded(head, receipt.run), receipt);
  save(receipt);
  if (pkg.status === 'verified') return;
  try { registryArchive(pkg, '.comparison-'); }
  catch (cause) {
    pkg.lastAvailabilityAttempt = { at: now(), outcome: 'pending-or-failed', detail: String(cause.message ?? cause) };
    save(receipt); throw cause;
  }
  pkg.status = 'verified'; pkg.verifiedAt = now();
  pkg.publication ??= { basis: 'registry-archive', integrity: pkg.integrity };
  pkg.lastAvailabilityAttempt = { at: pkg.verifiedAt, outcome: 'verified' }; save(receipt);
}

if (run('git', ['branch', '--show-current']).trim() !== 'publish'
  || run('git', ['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('Use clean committed source on the separately authorized publish branch.');
run('git', ['merge-base', '--is-ancestor', source, 'HEAD']);
if (run('git', ['diff', '--name-only', source, 'HEAD']).trim().split('\n').filter(Boolean).some(path => !/^\.github\/releases\/\d+\.json$/.test(path))) throw new Error('The running checkout differs from reviewed release source.');
const lock = join(root, 'publication.lock'); mkdirSync(lock);
const owner = lstatSync(lock);
let failed = false, primary;
try { if (action === 'publish') publish(); else if (action === 'verify') verify(); else checkpoint(); }
catch (cause) { failed = true; primary = cause; }
if (action !== 'checkpoint' && !checkpointUncertain) {
  try { checkpoint(); }
  catch (cause) { primary = failed ? new AggregateError([primary, cause], 'Release action and receipt checkpoint failed') : cause; failed = true; }
}
try {
  const current = lstatSync(lock);
  if (current.dev !== owner.dev || current.ino !== owner.ino) throw new Error('Original publication lock changed; retain it for inspection.');
  rmdirSync(lock);
} catch (cause) {
  if (failed) throw new AggregateError([primary, cause], 'Release action and original lock cleanup failed');
  throw cause;
}
if (failed) throw primary;
process.stdout.write('Next RELEASE_PUBLISH_HEAD=' + publishHead + '\n');
