/**
 * Where a process's start went: one `[boot-trace] load-account` line per process, said when its loading has been
 * quiet for two seconds and again at its exit if anything was loaded since.
 *
 * A program's start is mostly the loading of its modules, and nothing said how that time divides. The account keeps
 * a stack of what the loader is doing on the process's thread and charges each stretch of the clock to the top of
 * it, so every phase's time is its OWN: a module's `evaluate` stops while a `require` inside it resolves, reads,
 * compiles and evaluates another, and resumes when that returns. The phases:
 *
 *   resolve    a request made a file's path (`Module._resolveFilename`'s work), for every `require`, cached or not
 *   read       the file's source read from the tree
 *   digest     the name a prepared body would have: the tree asked for its digest of the file, or the source just
 *              read hashed
 *   bodyRead   the prepared body read from the tree by that name and decoded to text (`preparedBytes` of it; a
 *              body taken by digest reads no source, so this is the file's only read). `preparedHit` and
 *              `preparedMiss` count the answers.
 *   transform  the source made a body here because none was prepared: types stripped, ES module syntax lowered
 *   compile    the body handed to V8. V8 parses lazily, so the functions a body defines are compiled when they are
 *              first called and that time is the caller's `evaluate`.
 *   evaluate   the body run, less everything its own requires did; also totalled by package
 *   builtin    one of the engine's own modules answered (Node's `lib`, evaluated once per process, and stand-ins)
 *   loader     the loader's own work around a file that is none of the above: the module object, its `require`,
 *              its wrapper
 *
 * What it costs: two clock reads and an add for each phase a file passes through, a few string operations to name
 * its package, and nothing per line of output. No stacks are taken and nothing is said per file.
 *
 * What it does not see: a body that yields (a lowered ES module awaiting an import, a top-level `await`) is charged
 * until its first yield; what it does after resuming is outside the account, as a timer's callback is. `accountedMs`
 * is the phases' sum, and is the time loading took. `wallMs` is the clock from the process's first load to the line
 * and `firstToLastLoadMs` to its last load: both include whatever the program did between its loads, so neither is
 * a loading time. The clock is the realm's `performance.now()`, which a browser coarsens (5 µs isolated, 100 µs not): a
 * phase of many short stretches is a sum of rounded readings.
 */
export const enum LoadPhase { Resolve, Read, Digest, BodyRead, Transform, Compile, Evaluate, Builtin, Loader }
const PHASE_NAMES = ['resolve', 'read', 'digest', 'bodyRead', 'transform', 'compile', 'evaluate', 'builtin', 'loader'] as const;
const PHASES = PHASE_NAMES.length;
/** How many packages the line names, by evaluate time. */
const PACKAGES_SAID = 20;

interface PackageAccount { files: number; bytes: number; evaluateMs: number }
export interface LoadAccount {
  firstAt: number;
  firstWallAt: number;
  lastAt: number;
  last: number;
  depth: number;
  kinds: number[];
  packages: Array<PackageAccount | undefined>;
  ms: number[];
  requires: number;
  files: number;
  sourceBytes: number;
  bodyBytes: number;
  preparedBytes: number;
  preparedHit: number;
  preparedMiss: number;
  byPackage: Map<string, PackageAccount>;
  said: number;
  timer?: ReturnType<typeof setTimeout>;
}

const accounts = new WeakMap<object, LoadAccount>();

export function loadAccountFor(process: object): LoadAccount {
  let account = accounts.get(process);
  if (!account) {
    const now = performance.now();
    account = {
      firstAt: now, firstWallAt: Date.now(), lastAt: now, last: now, depth: 0, kinds: [], packages: [],
      ms: new Array<number>(PHASES).fill(0), requires: 0, files: 0, sourceBytes: 0, bodyBytes: 0, preparedBytes: 0, preparedHit: 0, preparedMiss: 0,
      byPackage: new Map(), said: -1,
    };
    accounts.set(process, account);
  }
  return account;
}

/** The stretch since the last reading belongs to whatever is on top. */
function charge(account: LoadAccount, now: number): void {
  if (account.depth === 0) return;
  const top = account.depth - 1;
  const elapsed = now - account.last;
  account.ms[account.kinds[top]!]! += elapsed;
  const owner = account.packages[top];
  if (owner) owner.evaluateMs += elapsed;
}

export function enterLoadPhase(account: LoadAccount, phase: LoadPhase, owner?: PackageAccount): void {
  const now = performance.now();
  charge(account, now);
  account.kinds[account.depth] = phase;
  account.packages[account.depth] = owner;
  account.depth += 1;
  account.last = now;
}

export function leaveLoadPhase(account: LoadAccount): void {
  const now = performance.now();
  charge(account, now);
  account.depth -= 1;
  account.last = now;
  account.lastAt = now;
}

/** The package a file belongs to: the name after the last `node_modules`, or the application's own files as one. */
export function loadPackageOf(account: LoadAccount, resolvedPath: string): PackageAccount {
  const at = resolvedPath.lastIndexOf('/node_modules/');
  let name = '(application)';
  if (at !== -1) {
    const from = at + 14;
    let end = resolvedPath.indexOf('/', from);
    if (end !== -1 && resolvedPath.charCodeAt(from) === 64 /* @ */) end = resolvedPath.indexOf('/', end + 1);
    name = end === -1 ? resolvedPath.slice(from) : resolvedPath.slice(from, end);
  }
  let entry = account.byPackage.get(name);
  if (!entry) account.byPackage.set(name, entry = { files: 0, bytes: 0, evaluateMs: 0 });
  return entry;
}

/** A file's body is about to run: counted, and the line is due once loading has been quiet. */
export function countLoadedFile(process: object, account: LoadAccount, owner: PackageAccount, bodyBytes: number): void {
  account.files += 1;
  account.bodyBytes += bodyBytes;
  owner.files += 1;
  owner.bytes += bodyBytes;
  if (account.timer !== undefined) clearTimeout(account.timer);
  account.timer = setTimeout(() => { account.timer = undefined; sayLoadAccount(process, 'quiet'); }, 2000);
  (account.timer as { unref?: () => void }).unref?.();
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

export function sayLoadAccount(process: object, when: 'quiet' | 'exit'): void {
  const account = accounts.get(process);
  if (!account) return;
  if (account.timer !== undefined) { clearTimeout(account.timer); account.timer = undefined; }
  if (account.files === account.said) return;
  account.said = account.files;
  const view = process as { pid?: number; argv?: unknown };
  const now = performance.now();
  // A line said from inside a phase (a body that calls `process.exit`) counts that phase's stretch so far.
  charge(account, now);
  account.last = now;
  const ms: Record<string, number> = {};
  let accounted = 0;
  for (let phase = 0; phase < PHASES; phase += 1) { ms[PHASE_NAMES[phase]!] = round(account.ms[phase]!); accounted += account.ms[phase]!; }
  const packages = [...account.byPackage].sort((left, right) => right[1].evaluateMs - left[1].evaluateMs).slice(0, PACKAGES_SAID)
    .map(([name, entry]) => [name, entry.files, entry.bytes, round(entry.evaluateMs)]);
  console.log('[boot-trace]', JSON.stringify({
    event: 'load-account', at: Date.now(), when, pid: view.pid ?? null,
    entry: Array.isArray(view.argv) && typeof view.argv[1] === 'string' ? view.argv[1] : null,
    startedAt: account.firstWallAt,
    accountedMs: round(accounted), wallMs: round(now - account.firstAt), firstToLastLoadMs: round(account.lastAt - account.firstAt),
    requires: account.requires, files: account.files, sourceBytes: account.sourceBytes, bodyBytes: account.bodyBytes, preparedBytes: account.preparedBytes,
    preparedHit: account.preparedHit, preparedMiss: account.preparedMiss, packagesLoaded: account.byPackage.size,
    ms,
    columns: ['package', 'files', 'bodyBytes', 'evaluateMs'],
    packages,
  }));
}
