import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { createContainer } from '../src/index';

describe("the engine's node command", () => {
  it('ends a silent program when nothing is pending, well inside the minute it used to wait', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/quiet.js', 'const x = 1 + 1;\n');
    const container = createContainer({ vfs });
    const started = Date.now();
    const result = await container.run('node /app/quiet.js', { cwd: '/app' });
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('waits for a silent program whose own timer is still pending', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/later.js', 'setTimeout(() => { process.exitCode = 3; }, 3000);\n');
    const container = createContainer({ vfs });
    const result = await container.run('node /app/later.js', { cwd: '/app' });
    expect(result.exitCode).toBe(3);
  }, 20_000);
});
