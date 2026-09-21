// Node's own tests under the engine, in Node: the fidelity number. Each test
// file of Node's suite runs as a program of the engine over a filesystem
// mounting Node's test tree, with a timeout, and passes when it exits 0.
// `scripts/NODE-TESTS.md` says where the test tree comes from and what the
// prelude is for.
//
//   node scripts/node-tests.mjs --tests <node checkout> [--engine <dist/index.mjs>] [--match <prefix>] [--dir <test/parallel>] [--timeout <ms>] [--jobs <n>] [--prelude <file>] [--list-failures]
//
// Without --engine the build in this repository's `dist/` is measured
// (`npm run build:lib` writes it). --match selects test files by name
// prefix, `test-stream-` by default.
import * as nodeFs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The engine gives a guest its own `process` and reaches the host's too; the
// host's writers and exit are taken before anything of the engine loads.
const hostOut = process.stdout.write.bind(process.stdout);
const hostErr = process.stderr.write.bind(process.stderr);
const hostExit = process.exit.bind(process);
function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}
const TESTS = nodeFs.realpathSync(argument("tests", ""));
const ENGINE = resolve(argument("engine", resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.mjs")));
const MATCH = argument("match", "test-stream-");
const TIMEOUT = Number(argument("timeout", "8000"));
const LIST = process.argv.includes("--list-failures");
const ONE = argument("one", "");
const JOBS = Number(argument("jobs", "4"));
// `--prelude <file>` runs a script before each test, in the same program: a
// diagnostic to see past one gap to the next, never the number itself.
const PRELUDE = argument("prelude", "");
// `--dir <path>` is the directory of the checkout the tests are read from.
// Node keeps most of its tests in `test/parallel` and a module's own beside
// it: `test/wasi` holds the WASI tests and the compiled fixtures they load.
const DIR = argument("dir", "test/parallel");
const MOUNT = "/workspace/app";
if (!TESTS) { console.error("usage: --tests <node checkout> [--engine <dist/index.mjs>] [--match <prefix>]"); process.exit(2); }

// The engine loads only in the process that runs a test: it takes over
// this process's globals, `process.execPath` among them, and the parent
// that spawns the children must keep its own.
async function loadEngine() {
  if (!nodeFs.existsSync(ENGINE)) { hostErr(`no engine at ${ENGINE}: run \`npm run build:lib\` or pass --engine\n`); hostExit(2); }
  const engine = await import(pathToFileURL(ENGINE).href);
  // A window after the engine loaded: the engine ran a `node` command through
  // the host's own node when it saw a window at load, and runs it itself when
  // the window arrives after, which is what the tab's programs get.
  if (typeof globalThis.window === "undefined") globalThis.window = { navigator: { serviceWorker: {} } };
  return engine;
}

function normalize(path) {
  const parts = [];
  for (const part of `/${path}`.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
  return `/${parts.join("/")}`;
}
function nodeError(code, syscall, path) { return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path, errno: -2 }); }
const diskFilesystem = (VirtualFS) => class DiskVFS extends VirtualFS {
  inside(path) { return path === MOUNT || path.startsWith(`${MOUNT}/`); }
  onDisk(path) { return `${TESTS}${path.slice(MOUNT.length)}`; }
  diskStat(path) {
    let st; try { st = nodeFs.statSync(this.onDisk(path)); } catch { return null; }
    const ms = Math.floor(st.mtimeMs);
    return { isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => false, size: st.size, mode: st.mode, mtime: st.mtime, atime: st.atime, ctime: st.ctime, birthtime: st.birthtime, mtimeMs: ms, atimeMs: ms, ctimeMs: ms, birthtimeMs: ms };
  }
  existsSync(path) { const n = normalize(path); if (!this.inside(n)) return super.existsSync(n); return super.existsSync(n) || this.diskStat(n) !== null; }
  statSync(path) { const n = normalize(path); if (!this.inside(n) || super.existsSync(n)) return super.statSync(n); const s = this.diskStat(n); if (!s) throw nodeError("ENOENT", "stat", n); return s; }
  lstatSync(path) { return this.statSync(path); }
  readFileSync(path, options) {
    const n = normalize(path);
    if (!this.inside(n) || super.existsSync(n)) return super.readFileSync(n, options);
    const encoding = typeof options === "string" ? options : options?.encoding;
    try { return nodeFs.readFileSync(this.onDisk(n), encoding ? { encoding } : undefined); } catch { throw nodeError("ENOENT", "open", n); }
  }
  readdirSync(path, options) {
    const n = normalize(path);
    const own = super.existsSync(n) ? super.readdirSync(n, options) : [];
    if (!this.inside(n)) return own;
    let disk = [];
    // An empty directory that exists only in memory is a directory, not an
    // absent one: Node's own `test/common/tmpdir.js` makes `test/.tmp.0` and
    // then reads it, and taking "no entries" for "not there" failed four
    // tests whose children were otherwise running correctly.
    try { disk = nodeFs.readdirSync(this.onDisk(n), options); } catch { if (!super.existsSync(n)) throw nodeError("ENOENT", "scandir", n); }
    const names = new Set(own.map((entry) => (typeof entry === "string" ? entry : entry.name)));
    return [...own, ...disk.filter((entry) => !names.has(typeof entry === "string" ? entry : entry.name))];
  }
  realpathSync(path) { const n = normalize(path); return n; }
  // A directory that exists only on disk is still a directory to write into.
  // Node's own `test/common/tmpdir.js` calls `mkdirSync(test/.tmp.0)` without
  // `recursive`, and `test/` is on disk and not in memory, so every test that
  // refreshes the temp directory died on ENOENT for its parent.
  mkdirSync(path, options) {
    const n = normalize(path);
    const parent = n.slice(0, n.lastIndexOf("/")) || "/";
    if (this.inside(parent) && !super.existsSync(parent) && this.diskStat(parent)?.isDirectory()) {
      super.mkdirSync(parent, { recursive: true });
    }
    return super.mkdirSync(n, options);
  }
};

// One test per process: the engine runs a guest in this realm, and an
// assertion a guest raises in a callback would end the runner with it.
if (ONE) {
  const { VirtualFS, createContainer } = await loadEngine();
  const DiskVFS = diskFilesystem(VirtualFS);
  const file = ONE;
  const cwd = `${MOUNT}/${DIR}`;
  const vfs = new DiskVFS();
  if (PRELUDE) {
    vfs.writeFileSync(`${MOUNT}/.prelude.cjs`, nodeFs.readFileSync(PRELUDE, "utf8"));
    vfs.writeFileSync(`${cwd}/.run-${file}.cjs`, `require(${JSON.stringify(`${MOUNT}/.prelude.cjs`)});\nrequire("module")._load(${JSON.stringify(`${cwd}/${file}`)}, null, true);\n`);
  }
  const container = createContainer({ vfs });
  let streamed = "";
  const result = await container.run(`node ${PRELUDE ? `${cwd}/.run-${file}.cjs` : `${cwd}/${file}`}`, { cwd, onStderr: (text) => { streamed += text; hostErr(text); }, onStdout: () => {} });
  // What the run reports at its end and did not stream: an uncaught error's text.
  if (result.stderr && !streamed.includes(result.stderr.trim().slice(0, 80))) hostErr(result.stderr);
  hostExit(result.exitCode);
}

const { spawn } = await import("node:child_process");
const files = nodeFs.readdirSync(resolve(TESTS, DIR)).filter((name) => name.startsWith(MATCH) && /\.m?js$/u.test(name)).sort();
const results = [];
const started = Date.now();
const runOne = (file) => new Promise((resolveRun) => {
  const args = [process.argv[1], "--tests", TESTS, "--dir", DIR, "--one", file, "--engine", ENGINE, ...(PRELUDE ? ["--prelude", PRELUDE] : [])];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill("SIGKILL"); stderr += "\ntimeout"; }, TIMEOUT);
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("at ") && !line.includes("cwd() called"));
    const passed = code === 0;
    const reason = passed ? "" : (lines.find((line) => /Error|error:|failed|timeout/u.test(line)) ?? lines[0] ?? `exit ${code ?? signal}`);
    resolveRun({ file, passed, reason: reason.slice(0, 200), lines: lines.slice(0, 4) });
  });
});
let next = 0;
await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, async () => {
  while (next < files.length) results.push(await runOne(files[next++]));
}));
results.sort((a, b) => a.file.localeCompare(b.file));
const passed = results.filter((r) => r.passed).length;
hostOut(`${passed} of ${results.length} ${MATCH}* tests pass under ${ENGINE} in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
const reasons = new Map();
for (const r of results) if (!r.passed) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12)) hostOut(`  ${String(count).padStart(4)}  ${reason}\n`);
if (LIST) for (const r of results) if (!r.passed) hostOut(`FAIL ${r.file}\n${r.lines.map((line) => `    ${line.slice(0, 200)}`).join("\n")}\n`);
hostExit(0);
