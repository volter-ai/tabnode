/**
 * `internalBinding('cjs_lexer')` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's
 * src/node_cjs_lexer.cc split where V8 stands, its lexer merve (deps/merve) in `libnode.so`, called through the
 * program's glue (native/node/node_cjs_lexer.c). `parse(source)` answers `[exports, reexports]`, a Set of the names
 * the module exports and an Array of the specifiers it re-exports, both empty for no source or one merve cannot lex.
 */
import { address, intoMemory, libnode, withRoom } from './libnode';

const decoder = new TextDecoder();

export function createCjsLexerBinding(): Record<string, unknown> {
  return {
    parse(source?: unknown): [Set<string>, string[]] {
      if (source === null || source === undefined) return [new Set(), []];
      if (typeof source !== 'string') throw new TypeError('cjs_lexer.parse: a string');
      const program = libnode();
      const bytes = new TextEncoder().encode(source);
      const at = intoMemory(bytes);
      try {
        const analysis = program.exports.tabnode_cjs_parse(at, bytes.byteLength);
        if (analysis === 0) return [new Set(), []];
        try {
          if (program.exports.tabnode_cjs_valid(analysis) === 0) return [new Set(), []];
          const read = (reexport: number, index: number): string => {
            let text = '';
            withRoom(8, (out) => { program.exports.tabnode_cjs_name(analysis, reexport, index, out); return 0; }, (view) => {
              const data = view.getUint32(0, true), length = view.getUint32(4, true);
              text = data === 0 ? '' : decoder.decode(program.read(address(data), length));
            });
            return text;
          };
          const exports = new Set<string>();
          for (let index = 0, count = program.exports.tabnode_cjs_exports(analysis); index < count; index++) exports.add(read(0, index));
          const reexports: string[] = [];
          for (let index = 0, count = program.exports.tabnode_cjs_reexports(analysis); index < count; index++) reexports.push(read(1, index));
          return [exports, reexports];
        } finally { program.exports.tabnode_cjs_free(analysis); }
      } finally { program.exports.tabnode_free(at); }
    },
  };
}
