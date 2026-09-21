// The path openvscode-server's ExtensionHostConnection.start takes, end to
// end in the engine: the pack's host is installed into a VirtualFS at the
// path the tab uses, then forked the way the server forks it. The measure
// is the time from fork to the child's IPC message
// `{ type: "VSCODE_EXTHOST_IPC_READY" }`, with everything the child printed.
//
// Transcribed from openvscode-server 1.109.5 `out/server-main.js`
// (`ExtensionHostConnection.start`): `fork(asFileUri("bootstrap-fork").fsPath,
// ["--type=extensionHost", "--transformURIs", "--useHostProxy=false"], {
//   env, execArgv: ["--dns-result-order=ipv4first", ...], silent: true })`.
// On linux (the engine's platform) the env names
// `VSCODE_EXTHOST_WILL_SEND_SOCKET` and the parent waits for
// `VSCODE_EXTHOST_IPC_READY`; the named-pipe `VSCODE_EXTHOST_IPC_HOOK` is
// the Windows path. `$x` fills `VSCODE_ESM_ENTRYPOINT`,
// `VSCODE_HANDLES_UNCAUGHT_ERRORS`, `VSCODE_NLS_CONFIG`,
// `VSCODE_RECONNECTION_GRACE_TIME`; `e7` deletes DEBUG and LD_PRELOAD.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

const PACK = '/tmp/exthost-boot-pack';
const ROOT = '/opt/programs/openvscode-server/1.109.5';
const STALL_MS = 30_000;
const ARTIFACT = '/Users/yueranyuan/volter/browser-substrate/examples/vscode/public/programs/openvscode-server/1.109.5/07258626-267baabb/openvscode-server.zip';
const RESOURCES = '/Users/yueranyuan/volter/browser-substrate/examples/vscode/public/programs/openvscode-server/1.109.5/07258626-73c95db4/openvscode-server-resources.zip';

function extractPack(): void {
  if (existsSync(join(PACK, 'out/bootstrap-fork.js')) && existsSync(join(PACK, 'node_modules/@vscode/proxy-agent/package.json'))) return;
  execFileSync('python3', ['-c', `
import zipfile, os
from pathlib import Path
cache = Path(${JSON.stringify(PACK)})
cache.mkdir(parents=True, exist_ok=True)
root_files = ("product.json", "package.json")
art = zipfile.ZipFile(${JSON.stringify(ARTIFACT)})
for name in art.namelist():
    if not name.startswith("openvscode-server/"): continue
    rel = name[len("openvscode-server/"):]
    if not rel or rel.endswith("/"): continue
    keep = (
        rel == "out/bootstrap-fork.js"
        or rel.startswith("out/vs/workbench/api/node/")
        or rel == "out/vs/loader.js"
        or rel in ("out/nls.messages.json", "out/nls.messages.js", "out/nls.keys.json")
        or rel in root_files
    )
    if not keep: continue
    dest = cache / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(art.read(name))
res = zipfile.ZipFile(${JSON.stringify(RESOURCES)})
for name in res.namelist():
    if not name.startswith("openvscode-server-resources/node_modules/"): continue
    rel = name[len("openvscode-server-resources/"):]
    if not rel or rel.endswith("/"): continue
    dest = cache / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(res.read(name))
`]);
}

function installPack(vfs: VirtualFS): number {
  extractPack();
  let files = 0;
  const walk = (from: string, to: string): void => {
    for (const name of readdirSync(from)) {
      const src = join(from, name);
      const dest = `${to}/${name}`;
      const st = statSync(src);
      if (st.isDirectory()) {
        vfs.mkdirSync(dest, { recursive: true });
        walk(src, dest);
        continue;
      }
      vfs.writeFileSync(dest, new Uint8Array(readFileSync(src)));
      files += 1;
    }
  };
  vfs.mkdirSync(ROOT, { recursive: true });
  walk(PACK, ROOT);
  return files;
}

const PARENT = `
const { fork } = require('child_process');
const root = ${JSON.stringify(ROOT)};
const started = Date.now();
const env = { ...process.env };
env.VSCODE_CWD = root;
env.VSCODE_ESM_ENTRYPOINT = 'vs/workbench/api/node/extensionHostProcess';
env.VSCODE_HANDLES_UNCAUGHT_ERRORS = 'true';
env.VSCODE_NLS_CONFIG = JSON.stringify({
  userLocale: 'en',
  osLocale: 'en',
  resolvedLanguage: 'en',
  defaultMessagesFile: root + '/out/nls.messages.json',
  locale: 'en',
  availableLanguages: {},
});
env.VSCODE_RECONNECTION_GRACE_TIME = '10800000';
env.VSCODE_EXTHOST_WILL_SEND_SOCKET = '1';
delete env.VSCODE_EXTHOST_IPC_HOOK;
delete env.VSCODE_WILL_SEND_MESSAGE_PORT;
delete env.DEBUG;
delete env.LD_PRELOAD;
const child = fork(root + '/out/bootstrap-fork', [
  '--type=extensionHost',
  '--transformURIs',
  '--useHostProxy=false',
], {
  cwd: root,
  env,
  execArgv: ['--dns-result-order=ipv4first'],
  silent: true,
});
console.log('FORK_MS ' + (Date.now() - started) + ' pid ' + child.pid);
let stderr = '';
let stdout = '';
if (child.stderr) {
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    console.log('CHILD_STDERR ' + String(chunk));
  });
}
if (child.stdout) {
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    console.log('CHILD_STDOUT ' + String(chunk));
  });
}
child.on('message', (msg) => {
  console.log('CHILD_MSG ' + JSON.stringify(msg));
  if (msg && msg.type === 'VSCODE_EXTHOST_IPC_READY') {
    console.log('READY_MS ' + (Date.now() - started));
    child.kill();
    process.exit(0);
  }
  if (msg && msg.type === 'VSCODE_EXTHOST_DISCONNECTED') {
    console.log('DISCONNECTED_MS ' + (Date.now() - started));
  }
});
child.on('error', (err) => {
  console.log('CHILD_ERROR ' + err);
});
child.on('exit', (code, signal) => {
  console.log('CHILD_EXIT code=' + code + ' signal=' + signal + ' ms=' + (Date.now() - started));
  console.log('CHILD_STDERR_TOTAL ' + JSON.stringify(stderr));
  console.log('CHILD_STDOUT_TOTAL ' + JSON.stringify(stdout));
  process.exit(code ? 1 : 0);
});
setTimeout(() => {
  console.log('STALL_MS ' + (Date.now() - started));
  console.log('CHILD_STDERR_TOTAL ' + JSON.stringify(stderr));
  console.log('CHILD_STDOUT_TOTAL ' + JSON.stringify(stdout));
  child.kill();
  process.exit(2);
}, ${STALL_MS});
`;

describe('the extension host, forked the way the server forks it', () => {
  it('sends VSCODE_EXTHOST_IPC_READY, and the parent prints the time and the child', async () => {
    const vfs = new VirtualFS();
    const files = installPack(vfs);
    expect(files).toBeGreaterThan(100);
    expect(vfs.existsSync(`${ROOT}/out/bootstrap-fork.js`)).toBe(true);
    expect(vfs.existsSync(`${ROOT}/out/vs/workbench/api/node/extensionHostProcess.js`)).toBe(true);
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/parent.js', PARENT);
    const started = Date.now();
    const seen = await createContainer({ vfs }).run('node /work/parent.js', { cwd: ROOT });
    const elapsed = Date.now() - started;
    const timeline = [
      `elapsed_ms ${elapsed}`,
      `exit ${seen.exitCode}`,
      '--- stdout ---',
      seen.stdout,
      '--- stderr ---',
      seen.stderr,
    ].join('\n');
    console.log(timeline);
    const ready = /READY_MS (\d+)/.exec(seen.stdout);
    const stall = /STALL_MS (\d+)/.exec(seen.stdout);
    const exit = /CHILD_EXIT code=([^\s]+) signal=([^\s]+) ms=(\d+)/.exec(seen.stdout);
    expect(seen.stdout, timeline).toMatch(/FORK_MS /);
    if (ready) {
      const ms = Number(ready[1]);
      expect(ms, timeline).toBeLessThan(10_000);
      return;
    }
    expect.fail(
      stall
        ? `stalled at ${stall[1]} ms\n${timeline}`
        : exit
          ? `child exited code=${exit[1]} signal=${exit[2]} at ${exit[3]} ms\n${timeline}`
          : `no ready, stall, or exit\n${timeline}`,
    );
  }, 90_000);
});
