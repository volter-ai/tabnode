// A shell script whose first statement is one of the engine's defined
// commands (`node`) under a process host: the script stops after it
// (measured in browser-substrate's tab 2026-09-28), while the same
// statements on a -c line, or after a builtin, run whole.
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { createContainer } from '../src/index';
import { installNodeProcessHost, nodeProcessHostInstalled } from '../src/node-process-host';

let hostCalls = 0;
installNodeProcessHost({ run: async (launch) => {
  hostCalls += 1;
  const delay = Number(process.env.HOST_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (process.env.HOST_WRITES) launch.streams?.onStdout?.('from-node\n');
  if (process.env.HOST_READS && launch.stdinStream) { for await (const _chunk of launch.stdinStream) { /* drains the run's stdin as a hosted node would */ } }
  return { stdout: process.env.HOST_WRITES ? 'from-node\n' : '', stderr: '', exitCode: 0 };
} });

describe('a script whose first statement is a hosted node', () => {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/w', { recursive: true });
  vfs.writeFileSync('/w/first.sh', 'node -e 1\necho after\n');
  vfs.writeFileSync('/w/second.sh', ':\nnode -e 1\necho after\n');
  vfs.writeFileSync('/w/env.sh', 'env | grep -c TABNODE\necho end\n');
  const container = createContainer({ vfs });
  const run = async (line: string, token: string) => {
    let streamed = '';
    const out = await container.run(line, { cwd: '/w', processToken: token, env: process.env.WITH_ENV ? { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/w', TERM: 'dumb' } : undefined, onStdout: (chunk: string) => { streamed += chunk; }, onStderr: (chunk: string) => { streamed += '[err]' + chunk; } });
    return { ...out, streamed };
  };

  it('runs whole when a builtin comes first', async () => {
    const out = await run('sh /w/second.sh', 'r1');
    expect(out.stdout).toBe('after\n');
  });
  it('runs whole as a -c line', async () => {
    const out = await run("sh -c 'node -e 1; echo after'", 'r2');
    expect(out.stdout).toBe('after\n');
  });
  it('runs whole as a script file with node first', async () => {
    const out = await run('sh /w/first.sh', 'r3');
    console.log('FIRST', JSON.stringify(out));
    expect(out.stdout).toBe('after\n');
  });
  it("does the run's name reach a script", async () => {
    const top = await run('env | grep -c TABNODE', 'e1');
    const nested = await run('sh /w/env.sh', 'e2');
    const dashc = await run("sh -c 'env | grep -c TABNODE'", 'e3');
    const exported = await run("export TABNODE_X=1; sh /w/env.sh", 'e4');
    console.log('ENV', JSON.stringify({ top: top.stdout, nested: nested.stdout, dashc: dashc.stdout, exported: exported.stdout }));
  });
  it('which node answers', async () => {
    const type = await run('type node; command -v node', 'r5');
    const inline = await run('node -e "console.log(41)"', 'r6');
    console.log('STUB', JSON.stringify({ exists: vfs.existsSync('/usr/bin/node'), body: vfs.existsSync('/usr/bin/node') ? String(vfs.readFileSync('/usr/bin/node', 'utf8')).slice(0, 120) : null, bin: vfs.existsSync('/usr/bin') ? vfs.readdirSync('/usr/bin').slice(0, 12) : null }));
    console.log('INSTALLED', nodeProcessHostInstalled(), 'calls', hostCalls);
    console.log('PROBE', JSON.stringify({ type: type.stdout, inlineStreamed: inline.streamed, typeErr: type.stderr, inline: inline.stdout, inlineErr: inline.stderr, exit: inline.exitCode }));
  });
  it('the node lines went to the host', () => {
    expect(hostCalls).toBe(4);
  });
});
