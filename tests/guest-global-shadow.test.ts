// A guest's define on its global is the guest's to make, even where the host
// holds that name non-configurable. The substrate's execution worker pins
// `navigator` to a frozen record before any guest runs, and VS Code's
// extension host redefines `navigator` on start (Node 21 made it a global;
// the host hides it behind a throwing getter); the guest global reported the
// name configurable, then refused the define, and the extension host died.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

describe('a define the host refuses', () => {
  it('lands on the guest global, is read back from it, and leaves the host alone', async () => {
    const hostValue = Object.freeze({ platform: 'host' });
    // Reflect, not Object: the engine's own wrapper keeps every host-global define configurable.
    Reflect.defineProperty(globalThis, 'navigator', { value: hostValue, configurable: false, writable: false });
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync(
      '/work/main.js',
      "Object.defineProperty(globalThis, 'navigator', { get: () => ({ platform: 'guest' }) });\n"
        + "console.log('own ' + Object.getOwnPropertyDescriptor(globalThis, 'navigator').configurable);\n"
        + "console.log('has ' + ('navigator' in globalThis) + ' keys ' + Object.getOwnPropertyNames(globalThis).includes('navigator'));\n"
        + "console.log('sees ' + globalThis.navigator.platform);\n",
    );
    const seen = await createContainer({ vfs }).run('node /work/main.js', { cwd: '/work' });
    expect(seen.stderr).toBe('');
    expect(seen.stdout).toContain('own false');
    expect(seen.stdout).toContain('has true keys true');
    expect(seen.stdout).toContain('sees guest');
    expect(seen.exitCode).toBe(0);
    expect((globalThis as { navigator?: unknown }).navigator).toBe(hostValue);
  }, 20_000);
});
