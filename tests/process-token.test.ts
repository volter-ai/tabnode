// A run the host names is a process the container can be asked about. The
// host runs `container.run(command, { processToken })` and then asks three
// things about that name: how many timers the run's guest still holds, which
// ports its servers listen on, and to end it. Node's own loop is the measure
// of the first: a program that has printed and still holds a timer is not
// over, and a host reading zero timers for every program ended one at the
// first quiet moment after its first line.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { VirtualFS } from '../src/virtual-fs';
import { createContainer } from '../src/index';

/** What Node itself prints for the same program. */
function nodePrints(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'process-token-'));
  const file = join(dir, 'program.js');
  writeFileSync(file, source);
  // A login shell finds node: importing the engine replaces the host's
  // `process`, so its env is not the host's.
  return execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(file)}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
}

function containerWith(files: Record<string, string>) {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/app', { recursive: true });
  for (const [name, text] of Object.entries(files)) vfs.writeFileSync(`/app/${name}`, text);
  return createContainer({ vfs });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a run the host named', () => {
  it('reports the timer its guest holds, and none once it has fired', async () => {
    const source = "console.log('a');\nsetTimeout(() => console.log('b'), 300);\n";
    const container = containerWith({ 'timer.js': source });
    let running = true;
    const run = container.run('node /app/timer.js', { cwd: '/app', processToken: 'held' })
      .finally(() => { running = false; });

    // What the host's loop would read, one sample at a time, for as long as
    // the run lasts: a pending timer first, none after it fires, and the run
    // still open at that point rather than already forgotten.
    const samples: number[] = [];
    while (running) { samples.push(container.pendingTimers('held')); await delay(20); }
    const result = await run;

    expect(samples.some((count) => count > 0)).toBe(true);
    const firstZeroAfterATimer = samples.findIndex((count, index) => count === 0 && samples.slice(0, index).some((earlier) => earlier > 0));
    expect(firstZeroAfterATimer).toBeGreaterThan(0);
    // The timer was Node's work to wait for, and the program printed both
    // lines, as it does in Node.
    expect(result.stdout).toBe(nodePrints(source));
    expect(result.stdout).toBe('a\nb\n');
    // The run is over, so the name holds nothing.
    expect(container.pendingTimers('held')).toBe(0);
  }, 20_000);

  it('reports the port its guest listens on, and loses it when the run is stopped', async () => {
    const container = containerWith({
      'server.js': "const http = require('http');\nhttp.createServer((_req, res) => res.end('ok')).listen(41011);\nsetInterval(() => {}, 1000);\n",
    });
    const run = container.run('node /app/server.js', { cwd: '/app', processToken: 'serves' });

    let ports: number[] = [];
    for (let attempt = 0; attempt < 100 && ports.length === 0; attempt += 1) { ports = container.processPorts('serves'); await delay(20); }
    expect(ports).toEqual([41011]);
    expect(container.pendingTimers('serves')).toBeGreaterThan(0);

    expect(container.stopProcess('serves')).toBe(true);
    expect(container.processPorts('serves')).toEqual([]);
    expect(container.pendingTimers('serves')).toBe(0);
    // A stopped run ends: nothing of its loop is left to wait for.
    await run;
  }, 20_000);

  it('answers for a name nothing runs under without harm', async () => {
    const container = containerWith({ 'quiet.js': 'const x = 1 + 1;\n' });
    expect(container.pendingTimers('nobody')).toBe(0);
    expect(container.processPorts('nobody')).toEqual([]);
    expect(container.stopProcess('nobody')).toBe(false);
    // And again after a run of a different name has been and gone.
    await container.run('node /app/quiet.js', { cwd: '/app', processToken: 'ran' });
    expect(container.stopProcess('nobody')).toBe(false);
    expect(container.pendingTimers('ran')).toBe(0);
  }, 20_000);

  it('does not see another run in flight', async () => {
    const container = containerWith({
      'one.js': "const http = require('http');\nhttp.createServer((_req, res) => res.end('one')).listen(41021);\nsetInterval(() => {}, 1000);\n",
      'two.js': "const http = require('http');\nhttp.createServer((_req, res) => res.end('two')).listen(41022);\n",
    });
    const first = container.run('node /app/one.js', { cwd: '/app', processToken: 'one' });
    const second = container.run('node /app/two.js', { cwd: '/app', processToken: 'two' });

    for (let attempt = 0; attempt < 100 && (container.processPorts('one').length === 0 || container.processPorts('two').length === 0); attempt += 1) await delay(20);
    expect(container.processPorts('one')).toEqual([41021]);
    expect(container.processPorts('two')).toEqual([41022]);
    // Only the one with an interval is holding a timer.
    expect(container.pendingTimers('one')).toBeGreaterThan(0);
    expect(container.pendingTimers('two')).toBe(0);

    // Stopping one leaves the other exactly as it was.
    expect(container.stopProcess('two')).toBe(true);
    expect(container.processPorts('two')).toEqual([]);
    expect(container.processPorts('one')).toEqual([41021]);
    expect(container.pendingTimers('one')).toBeGreaterThan(0);

    container.stopProcess('one');
    await Promise.all([first, second]);
  }, 30_000);
});
