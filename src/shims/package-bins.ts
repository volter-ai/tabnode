/**
 * An executable Node script reaches the existing Node launch owner after the
 * shell has resolved its path. Resolving a whole syntax tree in advance uses
 * the wrong PATH/cwd after an earlier export or cd (ADR-0007). The supplier
 * owns lookup, permissions, functions and builtins; this callback only offers
 * a recognized interpreter for the executable it actually selected.
 */
import type { CommandContext, ExecResult, ScriptExecutor } from 'just-bash';
import type { VirtualFS } from '../virtual-fs';
import { executableHeader, nodeShebang } from './executable-header';

export function nodeScriptExecutor(
  tree: VirtualFS,
  launch: (args: string[], context: CommandContext) => Promise<ExecResult>,
): ScriptExecutor {
  return async (resolvedPath, args, context) => {
    if (!nodeShebang(executableHeader(tree, resolvedPath))?.plain) return undefined;
    // Node's main module follows the selected executable's link on this same
    // tree. Preserve a realpath/read failure through the supplier's ordinary
    // external-command error path rather than selecting a different file.
    const script = tree.realpathSync(resolvedPath);
    return launch([script, ...args], context);
  };
}
