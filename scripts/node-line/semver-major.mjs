// Every semver-major commit between Node release lines, from Node's own changelogs, classed by scripts/node-line/classes.json,
// written as src/node-line-changes.json: the denominator for "how far is Node 24's library, presenting as Node 20, from Node 20".
//   node scripts/node-line/semver-major.mjs --changelogs <dir holding CHANGELOG_V19.md … CHANGELOG_V24.md>
// The changelogs are nodejs/node's doc/changelogs files (not vendored here; fetched and read on the date in the output).
// Each x.0.0 release lists its "Semver-Major Commits"; a commit's id is its PR number and sha. The enumeration is parsed,
// never typed. The class of each is a reading of its TITLE (classes.json says where a diff was read instead).
import * as fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const directory = resolve(arg('changelogs', '.'));
const classes = JSON.parse(fs.readFileSync(resolve(here, 'classes.json'), 'utf8'));
const rules = classes.rules.map(([pattern, cls]) => [new RegExp(pattern), cls]);
const LINES = [19, 20, 21, 22, 23, 24];
const row = /^\* \\?\[\[`([0-9a-f]+)`\]\([^)]*\)\\?\] - (?:\*\*\(SEMVER-MAJOR\)\*\* )?\*\*([^*]+)\*\*: (.*?) \(([^()]*)\) \[#(\d+)\]/;
const rows = [], unparsed = [];
for (const line of LINES) {
  const text = fs.readFileSync(resolve(directory, `CHANGELOG_V${line}.md`), 'utf8').split('\n');
  const release = text.findIndex((l) => new RegExp(`^## .*Version ${line}\\.0\\.0 `).test(l));
  let at = text.findIndex((l, index) => index > release && l.startsWith('### Semver-Major Commits'));
  if (release < 0 || at < 0) throw new Error(`CHANGELOG_V${line}.md has no ${line}.0.0 semver-major section`);
  for (at += 1; at < text.length && !text[at].startsWith('### '); at++) {
    const found = row.exec(text[at]);
    if (!found) { if (text[at].startsWith('* ')) unparsed.push({ line, text: text[at].slice(0, 160) }); continue; }
    rows.push({ line, sha: found[1], subsystem: found[2].replaceAll('\\', ''), title: found[3].replaceAll('\\', ''), pr: Number(found[5]) });
  }
}
for (const extra of classes.unparsed) rows.push({ line: extra.line, sha: extra.sha, subsystem: extra.subsystem, title: extra.title, pr: extra.pr, class: extra.class, note: extra.note });
if (unparsed.length !== classes.unparsed.length) throw new Error(`${unparsed.length} changelog lines did not parse and classes.json accounts for ${classes.unparsed.length}: ${JSON.stringify(unparsed)}`);
// What presenting the older behaviour would take, by class: these are the engine's own files, so each is expressible.
const present = {
  c: 'a branch on the declared line where the carried library decides it (a constant or a few lines in one lib file); hours to a day each, with the measurement on the real Node of each line that node-line.ts requires',
  d: 'the removed member or the old acceptance restored in the carried library for the older line; hours each',
  e: 'the warning not emitted for the older line (one condition where the deprecation is declared); minutes each',
};
for (const entry of rows) {
  if (!entry.class) {
    const byPr = classes.byPr[String(entry.pr)];
    const key = `${entry.subsystem}: ${entry.title}`;
    if (byPr) { entry.class = byPr[0]; entry.note = byPr[1]; }
    else { const rule = rules.find(([pattern]) => pattern.test(key)); entry.class = rule ? rule[1] : 'unclassed'; }
  }
  if (present[entry.class]) {
    entry.present = present[entry.class];
    entry.reached = classes.reached[String(entry.pr)] ?? 'not determined: no application\'s built server code was searched for it';
  }
}
const span = (from, to) => rows.filter((entry) => entry.line > from && entry.line <= to);
const count = (list) => { const out = { a: 0, b: 0, c: 0, d: 0, e: 0, v: 0, unclassed: 0 }; for (const entry of list) out[entry.class] += 1; return out; };
const out = {
  about: classes.about,
  source: 'nodejs/node doc/changelogs/CHANGELOG_V19.md … CHANGELOG_V24.md, the "Semver-Major Commits" of each x.0.0 release',
  read: arg('read', new Date().toISOString().slice(0, 10)),
  counts: { '20 to 24': { commits: span(20, 24).length, ...count(span(20, 24)) }, '18 to 20': { commits: span(18, 20).length, ...count(span(18, 20)) } },
  rows,
};
fs.writeFileSync(resolve(here, '../../src/node-line-changes.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`Node line changes: ${rows.length} semver-major commits; 20 to 24 ${JSON.stringify(out.counts['20 to 24'])}; 18 to 20 ${JSON.stringify(out.counts['18 to 20'])}`);
const open = rows.filter((entry) => entry.class === 'unclassed');
for (const entry of open) console.log(`  unclassed ${entry.line} #${entry.pr} ${entry.subsystem}: ${entry.title.slice(0, 100)}`);
