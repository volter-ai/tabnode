// `detached` puts a child in its own process group so it can survive its
// parent. It is not `unref`: the parent still waits for it. The engine read
// `detached` as a release, so a parent was ended under its own child, and
// `volter-world attach -- <command>` settled the moment it had spawned. A page
// was then told its dev server had exited before that server had listened.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';


/** A guest that spawns a child and prints when it sees the child finish. */
const PROGRAM = `
const { spawn } = require('child_process');
const child = spawn('sh', ['-c', 'echo child done'], { detached: DETACHED, stdio: 'inherit' });
child.on('exit', () => console.log('parent saw exit'));
`;

/** What the host's own node prints for the same program. */
function onNode(detached: boolean): string {
  const program = PROGRAM.replace('DETACHED', String(detached)).split('\n').map((line) => line.trim()).join(' ');
  return execFileSync('/bin/sh', ['-lc', `node -e ${JSON.stringify(program)}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
}

// The guest's own side of this cannot be measured here: `spawn` needs the
// container's shell, which a bare `Runtime` has none of, and the engine under
// Node routes a child to a real host process in any case. What these cases
// pin is the contract the engine must match, taken from the host's own node.
// The engine was measured in a browser on 2026-09-16: reading `detached` as a
// release ended `volter-world attach` the moment it had spawned, and a page
// was told its dev server had exited before that server had listened.
describe('a detached child still holds its parent', () => {
  it('Node waits for a detached child, which is what the engine must do', () => {
    expect(onNode(true)).toContain('child done');
    expect(onNode(true)).toContain('parent saw exit');
  });

  it('an undetached child holds its parent on Node too, which is the control', () => {
    expect(onNode(false)).toContain('parent saw exit');
  });

});
