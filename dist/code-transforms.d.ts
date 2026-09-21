/**
 * The ESM-to-CommonJS lowering the runtime applies to a module it loads:
 * `import` and `export` declarations rewritten over acorn's AST, with a
 * regex lowering behind it for a file acorn cannot parse.
 */
declare const __cjsExports: () => "$exports" | "exports";
export declare const setNodeLowering: (value: boolean) => void;
export { __cjsExports };
/**
 * Whether a module is ESM is a fact of its syntax, not of its text. Asking
 * whether the words `import` or `export` appear anywhere in the file lowered a
 * CommonJS module whose doc comment shows an `import` line (`date-fns/format`
 * does, in an @example) as ESM: its `exports` rewritten, `format` no longer a
 * function, and concurrently, which formats its log prefixes with it, dead
 * before its first command. The words are a prefilter; the answer is whether the
 * parsed module has an import or export declaration at its top level. A file the
 * parser cannot read as a module is judged by the words, as before.
 */
export declare function __substrateHasEsmSyntax(code: string): boolean;
export declare function transformEsmToCjsSimple(code: string): string;
//# sourceMappingURL=code-transforms.d.ts.map