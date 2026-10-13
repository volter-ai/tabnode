/**
 * The ESM-to-CommonJS lowering the runtime applies to a module it loads:
 * `import` and `export` declarations rewritten over acorn's AST, with a
 * regex lowering behind it for a file acorn cannot parse.
 */

import { forGuestRealm, takeFromHost } from './host-globals';
import * as acorn from 'acorn';
import { applySourceEdits } from './source-edits';

/**
 * A module's lowered exports go to the module's exports whatever the module
 * names. An ES module is lowered to a function body that writes `exports.x = …`,
 * and a module that declares its own top-level `exports`, as Vite's Node chunk
 * does for a CommonJS dependency rollup lifted into it, hoists that declaration
 * over the wrapper's: the lowering's first write, `__esModule`, hit an
 * undefined, and vue3-ssr's server died creating its Vite server; the same chunk
 * declares its own `require`, a const, and the lowered imports above it read it
 * in its dead zone. For the Node loader's lowering the writes and the requires
 * name the wrapper's own parameters, `$exports`, `$module` and `$require`, which
 * a module cannot declare over; the dev server's lowering of a browser module
 * keeps its names. A default import of a module the lowering marked as an ES
 * module takes its `default`, as Node does.
 */
let __nodeLowering = false;
const __cjsExports = () => __nodeLowering ? "$exports" : "exports";
const __cjsModule = () => __nodeLowering ? "$module" : "module";
const __cjsRequire = () => __nodeLowering ? "$require" : "require";
// The realm's own `Object` and `Symbol`, by names a module cannot declare over.
// Lowered code calls them before the module's own body has run -- its exports
// are defined at the top -- and a module that imports a binding called `Object`
// (typebox does, its object type) had the lowering's `Object.defineProperty`
// read that import in its dead zone. The dev server's lowering of a browser
// module keeps the plain names, which exist where that module runs.
const __cjsObject = () => __nodeLowering ? "__browserRuntimeObject" : "Object";
const __cjsSymbol = () => __nodeLowering ? "__browserRuntimeSymbol" : "Symbol";
const __cjsDefault = (expression: string) => __nodeLowering ? "__browserRuntimeInteropDefault(" + expression + ")" : expression;
// The helper lowered code calls by bare name. It is a name on the realm, so
// it goes up when a guest first exists, not when this module is loaded.
forGuestRealm(() => {
  if ((globalThis as Record<string, unknown>).__browserRuntimeInteropDefault) return;
  takeFromHost(globalThis, '__browserRuntimeInteropDefault', (imported: any) => imported && imported.__esModule && "default" in imported ? imported.default : imported);
});
forGuestRealm(() => {
  if (!(globalThis as Record<string, unknown>).__browserRuntimeObject) takeFromHost(globalThis, '__browserRuntimeObject', Object);
  if (!(globalThis as Record<string, unknown>).__browserRuntimeSymbol) takeFromHost(globalThis, '__browserRuntimeSymbol', Symbol);
});
export const setNodeLowering = (value: boolean): void => { __nodeLowering = value; };
export { __cjsExports, __cjsObject };

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
export function __substrateHasEsmSyntax(code: string): boolean {
  if (!/\bimport\b|\bexport\b/.test(code)) return false;
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch {
    return true;
  }
  for (const node of ast.body) {
    const type = node.type;
    if (type === "ImportDeclaration" || type === "ExportNamedDeclaration" || type === "ExportDefaultDeclaration" || type === "ExportAllDeclaration") return true;
  }
  return false;
}

export function transformEsmToCjsSimple(code: string): string {
  try {
    return transformEsmToCjsAst(code);
  } catch {
    return transformEsmToCjsRegex(code);
  }
}

/**
 * A named import is a live binding, not a copy. The loader lowered `import { f }
 * from "./b.js"` to `const { f } = require("./b.js")`, which takes the value the
 * exports object holds at the moment the import runs. Inside a cycle that moment
 * is before the other module has assigned anything, so the copy stayed
 * `undefined` for the life of the program: world-core's `ancestry.js` and
 * `storage.js` import each other, and entering the cycle from `ancestry.js` left
 * `stateDirName` undefined, so `volter world up` died with "stateDirName is not
 * a function" while a plain import of the package answered `typeof stateDirName
 * === "function"`.
 *
 * The lowering does what esbuild does: one namespace binding per source,
 * `const __substrateImport1 = require("./b.js")`, and every reference to an
 * imported local rewritten to a property read on it, so the read happens at use.
 * A function declared in the other module is hoisted and callable mid-cycle, and
 * a `let` the other module assigns later shows through. This is the import side
 * of the rule the named-export lowering states for exports.
 *
 * References are found on the same acorn AST the lowering already parses, with a
 * scope chain so an inner `function g(a) {}` keeps its own `a`. An imported local
 * is never rewritten where it is written to (`a = 1`, `a++`, a destructuring
 * target), so assigning to an import stays the TypeError Node raises. Each local
 * also keeps a module-scope `const` of its eagerly read value, wrapped so a
 * getter that throws mid-cycle cannot stop the module: a reference the scope walk
 * declines to rewrite then reads the value the old lowering gave it instead of an
 * undeclared name. That const is also what makes an assignment throw.
 *
 * The parser here is acorn without the JSX plugin, so a file with JSX in it never
 * reaches this transform — its parse throws and the lowering falls back to the
 * regular-expression path.
 */
const __substrateImportName = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const __substrateSkipKeys = new Set(["type", "start", "end", "loc", "range"]);

function __substrateImportRead(namespace: any, name: any) {
  return __substrateImportName.test(name) ? namespace + "." + name : namespace + "[" + JSON.stringify(name) + "]";
}

function __substrateBindingNames(pattern: any, names: any) {
  if (!pattern || typeof pattern !== "object") return;
  if (pattern.type === "Identifier") names.add(pattern.name);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) __substrateBindingNames(property.type === "RestElement" ? property.argument : property.value, names);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) __substrateBindingNames(element, names);
  else if (pattern.type === "AssignmentPattern") __substrateBindingNames(pattern.left, names);
  else if (pattern.type === "RestElement") __substrateBindingNames(pattern.argument, names);
}

/** The let, const, class and function names a block introduces. */
function __substrateLexicalNames(statements: any, names: any) {
  for (const statement of statements || []) {
    if (!statement || typeof statement !== "object") continue;
    if (statement.type === "VariableDeclaration" && statement.kind !== "var") for (const declarator of statement.declarations) __substrateBindingNames(declarator.id, names);
    else if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) names.add(statement.id.name);
  }
}

/** The var and function names hoisted to a function's own scope, not crossing into a nested function. */
function __substrateVarNames(node: any, names: any) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const item of node) __substrateVarNames(item, names); return; }
  if (typeof node.type !== "string") return;
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") { if (node.id) names.add(node.id.name); return; }
  if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ClassExpression") return;
  if (node.type === "VariableDeclaration") {
    if (node.kind === "var") for (const declarator of node.declarations) __substrateBindingNames(declarator.id, names);
    return;
  }
  for (const key of Object.keys(node)) {
    if (__substrateSkipKeys.has(key)) continue;
    __substrateVarNames(node[key], names);
  }
}

function __substrateShadow(visible: any, names: any) {
  let narrowed = visible;
  for (const name of names) {
    if (!narrowed.has(name)) continue;
    if (narrowed === visible) narrowed = new Set(visible);
    narrowed.delete(name);
  }
  return narrowed;
}

function __substrateLiveImportBindings(code: any) {
  if (!/\bimport\b/u.test(code)) return code;
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }); } catch { return code; }
  const declarations = ast.body.filter((node) => node.type === "ImportDeclaration" && node.specifiers.length > 0);
  if (declarations.length === 0) return code;
  let prefix = "__substrateImport";
  while (code.includes(prefix)) prefix += "_";
  const reads = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const edits: Array<[number, number, string]> = [];
  for (const declaration of declarations as any[]) {
    const specifier = declaration.source.value;
    let namespace = namespaces.get(specifier);
    const parts: string[] = [];
    if (namespace === void 0) {
      namespace = prefix + (namespaces.size + 1);
      namespaces.set(specifier, namespace);
      parts.push("const " + namespace + " = " + __cjsRequire() + "(" + JSON.stringify(specifier) + ");");
      // The imported module may still be settling, a top-level `await` in it
      // or in what it imports; an importer waits for it, as a module graph
      // evaluates in order. The marker becomes `await` when the loader runs
      // this body as an async function, and reads nothing otherwise.
      parts.push("/*__substrate_await__*/(" + namespace + " && " + namespace + "[" + __cjsSymbol() + ".for(\"substrate.pending\")]);");
    }
    for (const imported of declaration.specifiers) {
      const read = imported.type === "ImportDefaultSpecifier" ? __cjsDefault(namespace)
        : imported.type === "ImportNamespaceSpecifier" ? namespace
        : __substrateImportRead(namespace, imported.imported.type === "Identifier" ? imported.imported.name : imported.imported.value);
      reads.set(imported.local.name, read);
      parts.push("const " + imported.local.name + " = (() => { try { return " + read + "; } catch { return void 0; } })();");
    }
    edits.push([declaration.start, declaration.end, parts.join(" ")]);
  }

  const visitTarget = (node: any, visible: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier") return;
    if (node.type === "ObjectPattern") {
      for (const property of node.properties) {
        if (property.type === "RestElement") { visitTarget(property.argument, visible); continue; }
        if (property.computed) visit(property.key, visible);
        visitTarget(property.value, visible);
      }
      return;
    }
    if (node.type === "ArrayPattern") { for (const element of node.elements) visitTarget(element, visible); return; }
    if (node.type === "AssignmentPattern") { visitTarget(node.left, visible); visit(node.right, visible); return; }
    if (node.type === "RestElement") { visitTarget(node.argument, visible); return; }
    visit(node, visible);
  };

  const visit = (node: any, visible: any, asNewCallee = false) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item, visible); return; }
    if (typeof node.type !== "string") return;
    switch (node.type) {
      case "ImportDeclaration": case "ImportSpecifier": case "ImportDefaultSpecifier":
      // `export * as X from "…"` holds a name and a source, no reference: an
      // imported binding also called X was rewritten into the exported name,
      // and typebox's `export * as Guard` became `__substrateImport1`.
      case "ImportNamespaceSpecifier": case "ExportSpecifier": case "ExportAllDeclaration": case "MetaProperty":
      case "BreakStatement": case "ContinueStatement": case "PrivateIdentifier":
        return;
      case "Identifier":
        // A read is an expression, not a name. Bare as a `new X()` callee it
        // re-associates: the default read is a call, so `new
        // __browserRuntimeInteropDefault(ns)()` constructed the interop helper,
        // an arrow function, and called its result (github-slugger's `new
        // Slugger()` under remark-toc died "is not a constructor"). Node
        // constructs the imported class; parentheses keep the read one
        // operand there. Anywhere else the read stands bare: a read that
        // opens with `(` after a line the source ended without a semicolon
        // is a call of that line's last word (import-meta-resolve's
        // `const {parentURL} = context` followed by `assert(...)`, lowered,
        // died "context is not a function" under vite-plugin-fake-server),
        // where the read's own first token, a name, ends the line as the
        // source's did.
        if (visible.has(node.name)) edits.push([node.start, node.end, asNewCallee ? `(${reads.get(node.name)!})` : reads.get(node.name)!]);
        return;
      case "NewExpression":
        visit(node.callee, visible, true);
        visit(node.arguments, visible);
        return;
      case "MemberExpression":
        visit(node.object, visible, asNewCallee);
        if (node.computed) visit(node.property, visible);
        return;
      case "Property": {
        if (node.computed) visit(node.key, visible);
        const value = node.value;
        // A shorthand property carries the import, so it grows its key.
        if (node.shorthand && value && value.type === "Identifier" && visible.has(value.name)) {
          edits.push([value.start, value.end, value.name + ": " + reads.get(value.name)]);
          return;
        }
        visit(value, visible);
        return;
      }
      case "MethodDefinition": case "PropertyDefinition":
        if (node.computed) visit(node.key, visible);
        visit(node.value, visible);
        return;
      case "LabeledStatement": visit(node.body, visible); return;
      case "VariableDeclarator": visit(node.init, visible); return;
      case "AssignmentExpression":
        visitTarget(node.left, visible);
        visit(node.right, visible);
        return;
      case "UpdateExpression":
        if (node.argument && node.argument.type !== "Identifier") visit(node.argument, visible);
        return;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": {
        const names = new Set();
        if (node.id) names.add(node.id.name);
        for (const parameter of node.params) __substrateBindingNames(parameter, names);
        __substrateVarNames(node.body, names);
        if (node.body && node.body.type === "BlockStatement") __substrateLexicalNames(node.body.body, names);
        const inner = __substrateShadow(visible, names);
        for (const parameter of node.params) visitTarget(parameter, inner);
        if (node.body && node.body.type === "BlockStatement") for (const statement of node.body.body) visit(statement, inner);
        else visit(node.body, inner);
        return;
      }
      case "BlockStatement": case "StaticBlock": {
        const names = new Set();
        __substrateLexicalNames(node.body, names);
        const inner = __substrateShadow(visible, names);
        for (const statement of node.body) visit(statement, inner);
        return;
      }
      case "ClassDeclaration": case "ClassExpression": {
        const names = new Set();
        if (node.id) names.add(node.id.name);
        const inner = __substrateShadow(visible, names);
        visit(node.superClass, inner);
        visit(node.body, inner);
        return;
      }
      case "CatchClause": {
        const names = new Set();
        __substrateBindingNames(node.param, names);
        __substrateLexicalNames(node.body.body, names);
        const inner = __substrateShadow(visible, names);
        if (node.param) visitTarget(node.param, inner);
        for (const statement of node.body.body) visit(statement, inner);
        return;
      }
      case "ForStatement": {
        const names = new Set();
        if (node.init && node.init.type === "VariableDeclaration" && node.init.kind !== "var") for (const declarator of node.init.declarations) __substrateBindingNames(declarator.id, names);
        const inner = __substrateShadow(visible, names);
        visit(node.init, inner); visit(node.test, inner); visit(node.update, inner); visit(node.body, inner);
        return;
      }
      case "ForInStatement": case "ForOfStatement": {
        const names = new Set();
        if (node.left && node.left.type === "VariableDeclaration" && node.left.kind !== "var") for (const declarator of node.left.declarations) __substrateBindingNames(declarator.id, names);
        const inner = __substrateShadow(visible, names);
        if (node.left && node.left.type === "VariableDeclaration") visit(node.left, inner);
        else visitTarget(node.left, inner);
        visit(node.right, inner);
        visit(node.body, inner);
        return;
      }
      case "SwitchStatement": {
        visit(node.discriminant, visible);
        const names = new Set();
        for (const switchCase of node.cases) __substrateLexicalNames(switchCase.consequent, names);
        const inner = __substrateShadow(visible, names);
        for (const switchCase of node.cases) {
          visit(switchCase.test, inner);
          for (const statement of switchCase.consequent) visit(statement, inner);
        }
        return;
      }
      default:
        for (const key of Object.keys(node)) {
          if (__substrateSkipKeys.has(key)) continue;
          visit(node[key], visible);
        }
        return;
    }
  };

  visit(ast, new Set(reads.keys()));
  ast = undefined;
  edits.sort((a, b) => b[0] - a[0]);
  return applySourceEdits(code, edits);
}

/** AST-based ESM→CJS transform using acorn. */
function transformEsmToCjsAst(code: string): string {
  code = __substrateLiveImportBindings(code);
  let ast: acorn.Program | undefined = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });

  // Collect replacements as [start, end, replacement] sorted by start descending
  const replacements: Array<[number, number, string]> = [];
  // An exported function declaration's export is installed before the module
  // body runs, because a function declaration is hoisted and Node initializes
  // its export binding before evaluation. Installed where the declaration
  // stands, a module reached through a cycle from above its own imports saw
  // nothing: b.js imports a.js, a.js imports f back from b.js and calls it
  // while b.js is still evaluating a.js, and the call found undefined though f
  // is declared. The getters go first, on the module's first line so every
  // later line keeps its number.
  const hoisted: string[] = [];
  let sideEffectImports = 0;

  for (const node of (ast as any).body) {
    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      const specs = node.specifiers;

      if (specs.length === 0) {
        // Side-effect import: import './polyfill'. The module may still be
        // settling, a top-level `await` in it; the importer waits for it as
        // for any import (the marker becomes `await` in an async body).
        sideEffectImports += 1;
        const namespace = `__substrateImportSide${sideEffectImports}`;
        replacements.push([node.start, node.end, `const ${namespace} = ${__cjsRequire()}(${JSON.stringify(source)}); /*__substrate_await__*/(${namespace} && ${namespace}[${__cjsSymbol()}.for("substrate.pending")]);`]);
      } else {
        const defaultSpec = specs.find((s: any) => s.type === 'ImportDefaultSpecifier');
        const nsSpec = specs.find((s: any) => s.type === 'ImportNamespaceSpecifier');
        const namedSpecs = specs.filter((s: any) => s.type === 'ImportSpecifier');

        const parts: string[] = [];
        if (defaultSpec) {
          parts.push(`const ${defaultSpec.local.name} = ${__cjsDefault(__cjsRequire() + "(" + JSON.stringify(source) + ")")}`);
        }
        if (nsSpec) {
          parts.push(`const ${nsSpec.local.name} = ${__cjsRequire()}(${JSON.stringify(source)})`);
        }
        if (namedSpecs.length > 0) {
          const bindings = namedSpecs.map((s: any) => {
            if (s.imported.name === s.local.name) return s.local.name;
            return `${s.imported.name}: ${s.local.name}`;
          }).join(', ');
          if (defaultSpec) {
            // Mixed: import React, { useState } from 'react'
            // Default already handled, just destructure from same require
            parts.push(`const { ${bindings} } = ${__cjsRequire()}(${JSON.stringify(source)})`);
          } else {
            parts.push(`const { ${bindings} } = ${__cjsRequire()}(${JSON.stringify(source)})`);
          }
        }
        replacements.push([node.start, node.end, parts.join(';\n')]);
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      // The default export is the `default` name of the module's exports, as
      // Node's interop has it: a CJS require of an ES module gets the
      // namespace, `default` among its names. It was lowered to
      // `module.exports = X`, which threw away every named export defined
      // before it (readdirp exports `readdirp` by name and as the default;
      // chokidar imports the name and found the module was the function).
      const defineDefault = (value: string): string => `${__cjsObject()}.defineProperty(${__cjsExports()}, "default", { enumerable: true, configurable: true, get: function () { return ${value}; } });`;
      if (decl.type === 'FunctionDeclaration') {
        const funcCode = code.slice(decl.start, node.end);
        replacements.push([node.start, node.end, decl.id ? `${funcCode}\n${defineDefault(decl.id.name)}` : `${defineDefault(`(${funcCode})`)}`]);
      } else if (decl.type === 'ClassDeclaration') {
        const classCode = code.slice(decl.start, node.end);
        replacements.push([node.start, node.end, decl.id ? `${classCode}\n${defineDefault(decl.id.name)}` : `const __default_${node.start} = ${classCode};\n${defineDefault(`__default_${node.start}`)}`]);
      } else {
        // export default <expression>: evaluated here, in order, once. The expression's text is the statement's,
        // from after `default`: an expression's own range leaves out parentheses around it, so a text cut from the
        // expression's start to the statement's end kept the closing one of `export default (a => b);` without its
        // opening one (Next's compiled next.config: "Unexpected token ')'").
        const keyword = /^export(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*default/u.exec(code.slice(node.start, decl.start));
        const exprCode = code.slice(keyword ? node.start + keyword[0].length : decl.start, node.end).replace(/;\s*$/u, '');
        replacements.push([node.start, node.end, `const __default_${node.start} = (${exprCode});\n${defineDefault(`__default_${node.start}`)}`]);
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const decl = node.declaration;
        if (decl.type === 'FunctionDeclaration') {
          const name = decl.id.name;
          const funcCode = code.slice(decl.start, node.end);
          replacements.push([node.start, node.end, funcCode]);
          hoisted.push(`${__cjsObject()}.defineProperty(${__cjsExports()}, "${name}", { enumerable: true, get: function () { return ${name}; } });`);
        } else if (decl.type === 'ClassDeclaration') {
          const name = decl.id.name;
          const classCode = code.slice(decl.start, node.end);
          replacements.push([node.start, node.end, `${classCode}\n${__cjsObject()}.defineProperty(${__cjsExports()}, "${name}", { enumerable: true, get: function () { return ${name}; } });`]);
        } else if (decl.type === 'VariableDeclaration') {
          // The declaration stays as written, so the module keeps a binding of
          // its own; what follows is an export that reads that binding when
          // asked, the way esbuild lowers the same thing, so an assignment made
          // later shows through. Every emitted statement ends in a semicolon: an
          // unterminated `exports.X = X` before sucrase's enum IIFE made it a
          // call on X.
          const parts: string[] = [code.slice(decl.start, node.end).replace(/;?\s*$/u, ';')];
          const names: string[] = [];
          const collect = (pattern: any) => {
            if (!pattern) return;
            if (pattern.type === 'Identifier') names.push(pattern.name);
            else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) collect(property.type === 'RestElement' ? property.argument : property.value);
            else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements) collect(element);
            else if (pattern.type === 'AssignmentPattern') collect(pattern.left);
            else if (pattern.type === 'RestElement') collect(pattern.argument);
          };
          for (const declarator of decl.declarations) collect(declarator.id);
          for (const name of names) parts.push(`${__cjsObject()}.defineProperty(${__cjsExports()}, "${name}", { enumerable: true, get: function () { return ${name}; } });`);
          replacements.push([node.start, node.end, parts.join('\n')]);
        }
      } else if (node.source) {
        // Re-export: export { X } from './module'
        const source = node.source.value;
        // A named re-export is a live binding to the other module's export,
        // and an explicit export wins over a name a star export brought in
        // before it, as the language says: defined as a configurable getter,
        // it replaces the star's getter where an assignment threw on it (zod
        // 4.6 re-exports `toZod` by name after `export *` of a module that
        // has it).
        const parts: string[] = [];
        const tmpVar = `__reexport_${node.start}`;
        parts.push(`const ${tmpVar} = ${__cjsRequire()}(${JSON.stringify(source)})`);
        // The re-exported module may still be settling; wait for it as for an import.
        parts.push(`/*__substrate_await__*/(${tmpVar} && ${tmpVar}[${__cjsSymbol()}.for("substrate.pending")])`);
        for (const spec of node.specifiers) {
          parts.push(`${__cjsObject()}.defineProperty(${__cjsExports()}, "${spec.exported.name}", { enumerable: true, configurable: true, get: function () { return ${tmpVar}.${spec.local.name}; } })`);
        }
        replacements.push([node.start, node.end, parts.join(';\n')]);
      } else {
        // Local re-export: export { foo, bar }, a live binding to the local, and
        // an explicit export that replaces a star's getter of the same name.
        const parts: string[] = [];
        for (const spec of node.specifiers) {
          parts.push(`${__cjsObject()}.defineProperty(${__cjsExports()}, "${spec.exported.name}", { enumerable: true, configurable: true, get: function () { return ${spec.local.name}; } })`);
        }
        replacements.push([node.start, node.end, parts.join(';\n')]);
      }
    } else if (node.type === 'ExportAllDeclaration' && node.exported) {
      // export * as util from './util.js': one export, the module's namespace,
      // a live binding to the module object as a namespace import is. It was
      // lowered as a bare star, every name of the module spread over this one
      // and no `util` at all (zod 4.6's classic schemas read `util.derived`
      // through its core's `export * as util`).
      const source = node.source.value;
      const name = node.exported.type === 'Identifier' ? node.exported.name : node.exported.value;
      const tmpVar = `__reexport_${node.start}`;
      replacements.push([node.start, node.end, `const ${tmpVar} = ${__cjsRequire()}(${JSON.stringify(source)}); /*__substrate_await__*/(${tmpVar} && ${tmpVar}[${__cjsSymbol()}.for("substrate.pending")]); ${__cjsObject()}.defineProperty(${__cjsExports()}, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get: function () { return ${tmpVar}; } })`]);
    } else if (node.type === 'ExportAllDeclaration') {
      // export * from './helpers'
      const source = node.source.value;
      // `export * from "./core.js"` was lowered to an `Object.assign` of the
      // required module onto the exports: a copy of each value at that moment
      // rather than a live binding, and an assignment that throws where the
      // module exports a name of its own, since that export is a getter
      // (strtok3's index re-exports its core and exports its own `fromStream`
      // over it). The star defines a live, configurable getter per name the
      // module does not already export; a local export shadows a star's, as the
      // language says.
      const tmpVar = `__reexport_${node.start}`;
      replacements.push([node.start, node.end, `const ${tmpVar} = ${__cjsRequire()}(${JSON.stringify(source)}); /*__substrate_await__*/(${tmpVar} && ${tmpVar}[${__cjsSymbol()}.for("substrate.pending")]); (function (__from, __into) { for (const __key of ${__cjsObject()}.keys(__from)) { if (__key === "default" || __key === "__esModule" || ${__cjsObject()}.prototype.hasOwnProperty.call(__into, __key)) continue; ${__cjsObject()}.defineProperty(__into, __key, { enumerable: true, configurable: true, get: function () { return __from[__key]; } }); } })(${tmpVar}, ${__cjsExports()})`]);
    }
  }

  // Keep the original statement's semicolon using source coordinates. Descending disjoint edits never
  // changed that character in the old repeated concatenation; assembling spans once gives the same bytes
  // without copying a generated module for every import/export. Release its AST before allocating output.
  ast = undefined;
  replacements.sort((a, b) => b[0] - a[0]);
  for (const edit of replacements) if (code.charAt(edit[1] - 1) === ';') edit[2] += ';';
  const result = applySourceEdits(code, replacements);

  return hoisted.join(' ') + result;
}

/** Regex-based ESM→CJS fallback for code acorn can't parse. */
function transformEsmToCjsRegex(code: string): string {
  let transformed = code;

  transformed = transformed.replace(
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
    `const $1 = ${__cjsDefault(__cjsRequire() + '("$2")')}`,
  );
  transformed = transformed.replace(
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
    `const {$1} = ${__cjsRequire()}("$2")`,
  );
  transformed = transformed.replace(
    /export\s+default\s+function\s+(\w+)/g,
    `${__cjsExports()}.default = function $1`,
  );
  transformed = transformed.replace(
    /export\s+default\s+function\s*\(/g,
    `${__cjsExports()}.default = function(`,
  );
  transformed = transformed.replace(
    /export\s+default\s+/g,
    `${__cjsExports()}.default = `,
  );
  transformed = transformed.replace(
    /export\s+async\s+function\s+(\w+)/g,
    `${__cjsExports()}.$1 = async function $1`,
  );
  transformed = transformed.replace(
    /export\s+function\s+(\w+)/g,
    `${__cjsExports()}.$1 = function $1`,
  );
  transformed = transformed.replace(
    /export\s+const\s+(\w+)\s*=/g,
    `${__cjsExports()}.$1 =`,
  );

  return transformed;
}

/**
 * THE GUEST'S GLOBAL NAMES, REWRITTEN WHERE THEY ARE FREE (S2 K1 evaluate; lead ruling m-71c68f37). A module body ran
 * inside `with (__substrateGuestScope)` so that the few names whose realm value is not the guest's (the worker's
 * `self`, `postMessage`, `close` and event names, `window`/`document`/`location` that a Node process has not,
 * `Promise`, `fetch`, `performance`, `navigator`, `MessageChannel`/`MessagePort`/`Worker`) read the guest's. Node runs
 * a body in its wrapper with no `with`: every free name resolves lexically, then on the global. The `with` made every
 * free name of every function in the body a dynamic lookup through that object, at every call. Here only the free
 * references to those names become `<scope>.<name>`, as reads, writes, `typeof` and update operands, a bare call
 * keeping Node's undefined receiver (`(0,<scope>["<name>"])(...)`) and a shorthand property its key; every other free
 * name resolves as Node resolves it. A `new X(...)` callee is wrapped as before (`<construct>(X)`), with a guest name
 * inside it rewritten too. Answers undefined where name resolution is dynamic in the body itself (a `with` statement,
 * or a direct `eval`), and the body keeps the `with` wrapper.
 */
export function __substrateGuestNameEdits(ast: any, code: string, names: ReadonlySet<string>, scope: string,
  construct: (callee: string) => string): Array<[number, number, string]> | undefined {
  const edits: Array<[number, number, string]> = [];
  let dynamic = false;
  // Whether the code being walked is strict: an ES module's or "use strict" body, a class. A block's function
  // declaration reaches the enclosing function's scope only in sloppy code (Annex B); a class never leaves its block.
  let strict = false;
  const directive = (statements: any): boolean => {
    for (const statement of statements ?? []) {
      if (statement?.type !== "ExpressionStatement" || typeof statement.directive !== "string") return false;
      if (statement.directive === "use strict") return true;
    }
    return false;
  };
  // A function's own var names: `var` at any depth short of a nested function or class, and, in sloppy code only, a
  // function declared in one of its blocks. Its body's own top-level declarations are the lexical names.
  const hoisted = (node: any, names: Set<string>, sloppy: boolean, top: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) hoisted(item, names, sloppy, top); return; }
    if (typeof node.type !== "string") return;
    if (node.type === "FunctionDeclaration") { if (!top && sloppy && node.id) names.add(node.id.name); return; }
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ClassDeclaration" || node.type === "ClassExpression") return;
    if (node.type === "VariableDeclaration") { if (node.kind === "var") for (const declarator of node.declarations) __substrateBindingNames(declarator.id, names); return; }
    for (const key of Object.keys(node)) {
      if (__substrateSkipKeys.has(key)) continue;
      hoisted(node[key], names, sloppy, false);
    }
  };
  // Each shape is told apart by its own text, which names the scope: a read is `<scope>.<name>`, a bare call
  // `(0,<scope>["<name>"])`, a shorthand property `<name>: <scope>['<name>']`. A body that names the scope itself is
  // never given to this walker, so every occurrence of it in the result is one of these three, and a function's
  // text is given back exactly (runtime.ts __substrateUnscopeGuestNames). A name written with escapes
  // (`\u0073elf`) would come back unescaped: the body declines.
  const read = (name: string): string => `${scope}.${name}`;
  const called = (name: string): string => `(0,${scope}["${name}"])`;
  const shorthand = (name: string): string => `${name}: ${scope}['${name}']`;
  const edit = (node: any, text: string): void => {
    if (code.slice(node.start, node.end) !== node.name) { dynamic = true; return; }
    edits.push([node.start, node.end, text]);
  };
  const target = (node: any, visible: Set<string>): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier") { if (visible.has(node.name)) edit(node, read(node.name)); return; }
    if (node.type === "ObjectPattern") {
      for (const property of node.properties) {
        if (property.type === "RestElement") { target(property.argument, visible); continue; }
        if (property.computed) visit(property.key, visible);
        const value = property.value;
        if (property.shorthand && value?.type === "Identifier" && visible.has(value.name)) { edit(value, shorthand(value.name)); continue; }
        if (property.shorthand && value?.type === "AssignmentPattern" && value.left?.type === "Identifier" && visible.has(value.left.name)) {
          edit(value.left, shorthand(value.left.name)); visit(value.right, visible); continue;
        }
        target(value, visible);
      }
      return;
    }
    if (node.type === "ArrayPattern") { for (const element of node.elements) target(element, visible); return; }
    if (node.type === "AssignmentPattern") { target(node.left, visible); visit(node.right, visible); return; }
    if (node.type === "RestElement") { target(node.argument, visible); return; }
    visit(node, visible);
  };
  // A declaration's own pattern binds its names; only its defaults and computed keys are references.
  const declared = (node: any, visible: Set<string>): void => {
    if (!node || typeof node !== "object" || node.type === "Identifier") return;
    if (node.type === "ObjectPattern") { for (const property of node.properties) { if (property.type === "RestElement") declared(property.argument, visible); else { if (property.computed) visit(property.key, visible); declared(property.value, visible); } } return; }
    if (node.type === "ArrayPattern") { for (const element of node.elements) declared(element, visible); return; }
    if (node.type === "AssignmentPattern") { declared(node.left, visible); visit(node.right, visible); return; }
    if (node.type === "RestElement") declared(node.argument, visible);
  };
  const callee = (node: any, visible: Set<string>): void => {
    if (node?.type === "Identifier" && visible.has(node.name)) edit(node, called(node.name));
    else visit(node, visible);
  };
  const visit = (node: any, visible: Set<string>): void => {
    if (dynamic || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item, visible); return; }
    if (typeof node.type !== "string") return;
    switch (node.type) {
      case "WithStatement": dynamic = true; return;
      case "ImportDeclaration": case "ImportSpecifier": case "ImportDefaultSpecifier": case "ImportNamespaceSpecifier":
      case "ExportSpecifier": case "ExportAllDeclaration": case "MetaProperty": case "BreakStatement": case "ContinueStatement":
      case "PrivateIdentifier": case "Literal": case "Super": case "ThisExpression":
        return;
      case "Identifier":
        if (visible.has(node.name)) edit(node, read(node.name));
        return;
      case "CallExpression":
        // A direct eval resolves names at run time in this scope: the body keeps the `with`.
        if (node.callee?.type === "Identifier" && node.callee.name === "eval") { dynamic = true; return; }
        callee(node.callee, visible); visit(node.arguments, visible);
        return;
      case "TaggedTemplateExpression": callee(node.tag, visible); visit(node.quasi, visible); return;
      case "NewExpression":
        if (node.callee?.type === "Identifier") {
          const name = node.callee.name;
          if (visible.has(name)) edit(node.callee, construct(read(name)));
          else edits.push([node.callee.start, node.callee.end, construct(code.slice(node.callee.start, node.callee.end))]);
        } else visit(node.callee, visible);
        visit(node.arguments, visible);
        return;
      case "MemberExpression":
        visit(node.object, visible);
        if (node.computed) visit(node.property, visible);
        return;
      case "Property": {
        if (node.computed) visit(node.key, visible);
        const value = node.value;
        if (node.shorthand && value?.type === "Identifier" && visible.has(value.name)) { edit(value, shorthand(value.name)); return; }
        visit(value, visible);
        return;
      }
      case "MethodDefinition": case "PropertyDefinition":
        if (node.computed) visit(node.key, visible);
        visit(node.value, visible);
        return;
      case "LabeledStatement": visit(node.body, visible); return;
      case "VariableDeclarator": declared(node.id, visible); visit(node.init, visible); return;
      case "AssignmentExpression": target(node.left, visible); visit(node.right, visible); return;
      case "UpdateExpression": target(node.argument, visible); return;
      case "UnaryExpression": visit(node.argument, visible); return;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": {
        const outer = strict;
        const block = node.body && node.body.type === "BlockStatement";
        if (block && directive(node.body.body)) strict = true;
        // A parameter list is a scope of its own: its defaults see the parameters and the function's own name, never
        // the body's declarations (`function f(x = self) { var self }` reads the outer self).
        const parameters = new Set<string>();
        if (node.id && node.type !== "FunctionDeclaration") parameters.add(node.id.name);
        for (const parameter of node.params) __substrateBindingNames(parameter, parameters);
        if (node.type !== "ArrowFunctionExpression") parameters.add("arguments");
        const parameterScope = __substrateShadow(visible, parameters);
        for (const parameter of node.params) declared(parameter, parameterScope);
        const bound = new Set<string>(parameters);
        if (block) { hoisted(node.body.body, bound, !strict, true); __substrateLexicalNames(node.body.body, bound); }
        const inner = __substrateShadow(visible, bound);
        if (block) for (const statement of node.body.body) visit(statement, inner);
        else visit(node.body, inner);
        strict = outer;
        return;
      }
      case "BlockStatement": {
        const bound = new Set<string>();
        __substrateLexicalNames(node.body, bound);
        const inner = __substrateShadow(visible, bound);
        for (const statement of node.body) visit(statement, inner);
        return;
      }
      case "StaticBlock": {
        // A class static block is a var scope of its own, in strict code.
        const bound = new Set<string>();
        hoisted(node.body, bound, false, true);
        __substrateLexicalNames(node.body, bound);
        const inner = __substrateShadow(visible, bound);
        for (const statement of node.body) visit(statement, inner);
        return;
      }
      case "ClassDeclaration": case "ClassExpression": {
        const outer = strict;
        const bound = new Set<string>();
        if (node.id) bound.add(node.id.name);
        const inner = __substrateShadow(visible, bound);
        // The heritage is evaluated in strict code too, inside the class's own scope.
        strict = true;
        visit(node.superClass, inner);
        visit(node.body, inner);
        strict = outer;
        return;
      }
      case "CatchClause": {
        // The parameter's defaults see the parameter alone, never the body's declarations, as a function's do.
        const parameters = new Set<string>();
        __substrateBindingNames(node.param, parameters);
        if (node.param) declared(node.param, __substrateShadow(visible, parameters));
        const bound = new Set<string>(parameters);
        __substrateLexicalNames(node.body.body, bound);
        const inner = __substrateShadow(visible, bound);
        for (const statement of node.body.body) visit(statement, inner);
        return;
      }
      case "ForStatement": {
        const bound = new Set<string>();
        if (node.init && node.init.type === "VariableDeclaration" && node.init.kind !== "var") for (const declarator of node.init.declarations) __substrateBindingNames(declarator.id, bound);
        const inner = __substrateShadow(visible, bound);
        visit(node.init, inner); visit(node.test, inner); visit(node.update, inner); visit(node.body, inner);
        return;
      }
      case "ForInStatement": case "ForOfStatement": {
        const bound = new Set<string>();
        if (node.left && node.left.type === "VariableDeclaration" && node.left.kind !== "var") for (const declarator of node.left.declarations) __substrateBindingNames(declarator.id, bound);
        const inner = __substrateShadow(visible, bound);
        if (node.left && node.left.type === "VariableDeclaration") visit(node.left, inner);
        else target(node.left, inner);
        visit(node.right, inner);
        visit(node.body, inner);
        return;
      }
      case "SwitchStatement": {
        visit(node.discriminant, visible);
        const bound = new Set<string>();
        for (const switchCase of node.cases) __substrateLexicalNames(switchCase.consequent, bound);
        const inner = __substrateShadow(visible, bound);
        for (const switchCase of node.cases) { visit(switchCase.test, inner); for (const statement of switchCase.consequent) visit(statement, inner); }
        return;
      }
      default:
        for (const key of Object.keys(node)) {
          if (__substrateSkipKeys.has(key)) continue;
          visit(node[key], visible);
        }
    }
  };
  // The body's own top level is a function's (the wrapper's): its var, function and lexical names shadow too.
  strict = directive(ast.body);
  const top = new Set<string>();
  hoisted(ast.body, top, !strict, true);
  __substrateLexicalNames(ast.body, top);
  visit(ast.body, __substrateShadow(new Set(names), top));
  return dynamic ? undefined : edits;
}
