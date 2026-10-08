// A conservative AST inventory. Unsupported data flow is reported, never
// mistaken for an empty or complete binding. No type diagnostics are run.
import * as fs from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import ts from 'typescript';
import { limitations, manifest } from './parity-data.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const outputIndex = process.argv.indexOf('--out');
const output = resolve(outputIndex < 0 ? 'measurement/native.json' : process.argv[outputIndex + 1]);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
}
const js = walk(resolve(root, 'src/node-lib')).filter((path) => path.endsWith('.js'));
const registrations = ['src/node-lib/binding/index.ts', 'src/node-lib/internals/index.ts'];
const files = [...js, ...registrations.map((path) => resolve(root, path))];
const program = ts.createProgram(files, { allowJs: true, noResolve: true, noLib: true });
const checker = program.getTypeChecker(); // lexical symbol identity only
const entries = new Map();
const unresolved = new Map();
const handBound = new Set();
function site(node, source) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return `${relative(root, source.fileName)}:${line}`;
}
function add(key, node, source) {
  if (!entries.has(key)) entries.set(key, new Set());
  entries.get(key).add(site(node, source));
}
function gap(node, source, reason) {
  const key = `${site(node, source)}: ${node.getText(source)}`;
  unresolved.set(key, { site: site(node, source), expression: node.getText(source), reason });
}
for (const path of registrations) {
  const source = program.getSourceFile(resolve(root, path));
  const kind = path.includes('/binding/') ? 'binding' : 'internal';
  function visit(node) {
    // Every registered root is counted, even one no vendored caller reads.
    if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)
      && ts.isObjectLiteralExpression(node.parent) && ts.isBinaryExpression(node.parent.parent)
      && node.parent.parent.left.getText(source) === '__table') {
      const name = node.name.text;
      if (name) { handBound.add(`${kind}:${name}`); add(`${kind}:${name}`, node, source); }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && node.left.getText(source) === 'name' && ts.isStringLiteral(node.right)) {
      handBound.add(`${kind}:${node.right.text}`); add(`${kind}:${node.right.text}`, node, source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const path of js) {
  const source = program.getSourceFile(path);
  const aliases = new Map();
  const nodes = [];
  function collect(node) { nodes.push(node); ts.forEachChild(node, collect); }
  collect(source);
  const sym = (node) => checker.getSymbolAtLocation(node);
  function origin(node) {
    if (!node) return [];
    if (ts.isParenthesizedExpression(node)) return origin(node.expression);
    if (ts.isIdentifier(node)) return [...(aliases.get(sym(node)) ?? [])];
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'internalBinding' || name === 'require') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          if (name === 'internalBinding') return [`binding:${arg.text}`];
          if (handBound.has(`internal:${arg.text}`)) return [`internal:${arg.text}`];
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) return origin(node.expression).map((key) => `${key}.${node.name.text}`);
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (key && (ts.isStringLiteral(key) || ts.isNumericLiteral(key))) return origin(node.expression).map((name) => `${name}.${key.text}`);
    }
    if (ts.isNewExpression(node)) return origin(node.expression).map((key) => `${key}.prototype`);
    return [];
  }
  function bind(pattern, origins, node) {
    if (!origins.length) return false;
    let changed = false;
    if (ts.isIdentifier(pattern)) {
      const symbol = sym(pattern);
      if (!symbol) { gap(pattern, source, 'unresolved lexical binding'); return false; }
      const set = aliases.get(symbol) ?? new Set();
      for (const key of origins) if (!set.has(key)) { set.add(key); changed = true; }
      aliases.set(symbol, set);
    } else if (ts.isObjectBindingPattern(pattern) || ts.isObjectLiteralExpression(pattern)) {
      for (const part of pattern.elements ?? pattern.properties) {
        if (part.dotDotDotToken || ts.isSpreadAssignment(part)) { gap(part, source, 'binding rest/spread needs enumeration'); continue; }
        const property = part.propertyName ?? part.name;
        const key = property?.text;
        const target = part.initializer && ts.isPropertyAssignment(part) ? part.initializer : part.name;
        if (key === undefined) { gap(part, source, 'computed destructuring'); continue; }
        const values = origins.map((prefix) => `${prefix}.${key}`);
        for (const value of values) add(value, node, source);
        changed = bind(target, values, part) || changed;
      }
    } else { gap(pattern, source, 'unsupported binding pattern'); }
    return changed;
  }
  // A finite fixed point over lexical aliases, including destructuring and
  // constructed native handles. There is no arbitrary iteration/depth cap.
  let changed;
  do {
    changed = false;
    for (const node of nodes) {
      if (ts.isVariableDeclaration(node)) changed = bind(node.name, origin(node.initializer), node) || changed;
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) {
        changed = bind(node.left, origin(node.right), node) || changed;
      }
    }
  } while (changed);
  for (const node of nodes) {
    const values = origin(node);
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'internalBinding'
      && (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))) gap(node, source, 'dynamic internalBinding name');
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'require') {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg) && arg.text.startsWith('internal/')
        && !handBound.has(`internal:${arg.text}`) && !fs.existsSync(resolve(root, `src/node-lib/${arg.text}.js`))) {
        add(`internal:${arg.text}`, node, source);
        gap(node, source, 'internal module is neither vendored nor hand-bound');
      }
    }
    if ((ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && values.length) {
      for (const value of values) add(value, node, source);
    }
    if (ts.isElementAccessExpression(node) && origin(node.expression).length && !values.length) {
      gap(node, source, 'computed native member');
    }
    if (ts.isCallExpression(node) && origin(node.expression).length) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) || ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
        gap(node, source, 'native return object requires an explicit result contract');
      }
    }
    if (ts.isIdentifier(node) && values.length) {
      const parent = node.parent;
      const safe = (ts.isVariableDeclaration(parent) && (parent.name === node || parent.initializer === node))
        || ts.isBindingElement(parent) || ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)
        || (ts.isCallExpression(parent) && parent.expression === node) || (ts.isNewExpression(parent) && parent.expression === node)
        || (ts.isBinaryExpression(parent) && parent.left === node && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(parent.operatorToken.kind));
      if (!safe) gap(node, source, 'native value escapes statically enumerated member reads');
    }
  }
}
const classifications = JSON.parse(fs.readFileSync(resolve(root, 'scripts/native-classifications.json'), 'utf8'));
const exceptions = limitations();
if (classifications.nodeVersion !== manifest.nodeVersion) throw new Error('native classifications are for another Node line');
const inventory = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, sites]) => {
  const classification = classifications.entries[key];
  const exception = exceptions.find((entry) => entry.review?.verdict !== 'overturned' && entry.nativeEntries.includes(key));
  let status = 'UNCLASSIFIED';
  if (classification?.status === 'IMPLEMENTED' && classification.evidence && classification.source?.length
    && classification.source.every((path) => fs.existsSync(resolve(root, path.split(':')[0])))) status = 'IMPLEMENTED';
  if (classification?.status === 'REFUSING' && exception && classification.limitation === exception.id
    && classification.errorCode === exception.errorCode && classification.source?.length
    && classification.source.every((path) => fs.existsSync(resolve(root, path.split(':')[0])))) status = 'REFUSING';
  return { key, sites: [...sites].sort(), status, classification: classification ?? null };
});
const report = { nodeVersion: manifest.nodeVersion, sourceFiles: js.map((path) => relative(root, path)).sort(),
  entries: inventory, unresolved: [...unresolved.values()].sort((a, b) => a.site.localeCompare(b.site)),
  staleClassifications: Object.keys(classifications.entries).filter((key) => !entries.has(key)) };
fs.mkdirSync(dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
// This is the inventory, not a verdict: what Node's lib asks of its bindings. Which of them this engine answers is
// scripts/native-probe.mjs's table, made from this file.
console.log(`Native surface: an inventory of ${inventory.length} members Node's lib asks of its bindings, and ${report.unresolved.length} computed reads it could not name; native-probe.mjs says which are answered`);
