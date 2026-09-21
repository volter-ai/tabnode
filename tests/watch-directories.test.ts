// A directory that appears, or goes, is announced to a watcher of its parent,
// as Node announces one: `rename` with the directory's name. It is the only
// event a watcher of a tree has to start watching a new directory from, and
// webpack's watchpack, which watches each directory separately, needs it — a
// route file written into an unannounced directory reached no watcher, and
// Next answered 404 for the new route until its server was restarted.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmdirSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualFS } from '../src/virtual-fs';

/** What a watcher of `directory` hears while `act` runs, as `<event>:<name>` in order. */
function heard(fs: { watch(path: string, listener: (event: string, name: string) => void): { close(): void } }, directory: string, act: () => void): string[] {
  const events: string[] = [];
  const watcher = fs.watch(directory, (event, name) => { events.push(`${event}:${name}`); });
  act();
  watcher.close();
  return events;
}

/** The same, from Node on a real directory. */
async function heardFromNode(act: (root: string) => void, before?: (root: string) => void): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), 'watch-'));
  before?.(root);
  const events: string[] = [];
  // macOS also reports the temporary root's own appearance; only what happens inside it is the measure.
  const watcher = watch(root, (event, name) => { if (name === 'about') events.push(`${event}:${name}`); });
  act(root);
  await new Promise((resolve) => setTimeout(resolve, 200));
  watcher.close();
  return events;
}

describe('a watcher of a directory hears what appears in it', () => {
  it('announces a directory made in it, as Node does', async () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work', { recursive: true });
    const events = heard(fs as never, '/work', () => { fs.mkdirSync('/work/about'); });
    expect(events).toEqual(['rename:about']);
    expect(await heardFromNode((root) => { mkdirSync(join(root, 'about')); })).toEqual(['rename:about']);
  });

  it('announces each directory a recursive make brings into being', () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work', { recursive: true });
    const events = heard(fs as never, '/work', () => { fs.mkdirSync('/work/app/about', { recursive: true }); });
    expect(events).toEqual(['rename:app']);
  });

  it('announces a directory removed from it, as Node does', async () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work/about', { recursive: true });
    const events = heard(fs as never, '/work', () => { fs.rmdirSync('/work/about'); });
    expect(events).toEqual(['rename:about']);
    // The directory is there before the watch, so the one event is its removal;
    // making and removing it under one watch is coalesced by the host.
    expect(await heardFromNode((root) => { rmdirSync(join(root, 'about')); }, (root) => { mkdirSync(join(root, 'about')); })).toEqual(['rename:about']);
  });

  it('still announces a file written into it', () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work', { recursive: true });
    const created = heard(fs as never, '/work', () => { fs.writeFileSync('/work/page.js', 'export default 1'); });
    expect(created).toEqual(['rename:page.js']);
    const changed = heard(fs as never, '/work', () => { fs.writeFileSync('/work/page.js', 'export default 2'); });
    expect(changed).toEqual(['change:page.js']);
  });
});
