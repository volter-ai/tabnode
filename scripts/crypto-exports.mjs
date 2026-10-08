// The exports of `node:crypto` on the Node that runs this file, against src/shims/crypto-exports.ts's table.
//   node scripts/crypto-exports.mjs
// Prints the names, then what the table lacks and what it has that this Node does not. Exits 1 on a difference.
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
const names = Object.keys(crypto).sort();
const table = [...readFileSync(new URL('../src/shims/crypto-exports.ts', import.meta.url), 'utf8').matchAll(/^  (\w+): '(implemented|throws)',$/gm)].map((row) => row[1]);
const lacks = names.filter((name) => !table.includes(name)), extra = table.filter((name) => !names.includes(name));
console.log(`${process.version}: ${names.length} exports: ${names.join(' ')}`);
console.log(`the table lacks: ${lacks.join(' ') || 'none'}; the table has and this Node does not: ${extra.join(' ') || 'none'}`);
process.exit(lacks.length || extra.length ? 1 : 0);
