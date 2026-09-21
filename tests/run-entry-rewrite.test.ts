import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('running an entry', () => {
  it('does not rewrite a file run as it stands, so its watcher stays quiet', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/entry.js', 'module.exports = 1;\n');
    const events: string[] = [];
    const watcher = vfs.watch('/app/entry.js', (event) => { events.push(String(event)); });
    const before = vfs.statSync('/app/entry.js').mtimeMs;
    const runtime = new Runtime(vfs, { cwd: '/app' });
    runtime.runFile('/app/entry.js');
    expect(events).toEqual([]);
    expect(vfs.statSync('/app/entry.js').mtimeMs).toBe(before);
    watcher.close();
  });

  it('still writes changed code and fires the watcher once', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/entry.js', 'module.exports = 1;\n');
    const events: string[] = [];
    const watcher = vfs.watch('/app/entry.js', (event) => { events.push(String(event)); });
    const runtime = new Runtime(vfs, { cwd: '/app' });
    const result = runtime.execute('module.exports = 2;\n', '/app/entry.js');
    expect(result.exports).toBe(2);
    expect(vfs.readFileSync('/app/entry.js', 'utf8')).toBe('module.exports = 2;\n');
    expect(events.length).toBe(1);
    watcher.close();
  });
});
