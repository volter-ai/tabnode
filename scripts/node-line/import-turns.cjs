// How many event-loop turns pass while a chain of awaited import()s runs, on the Node that runs this file.
// The measurement behind src/node-line.ts's `freshEsModuleImportTurns` row. Run it with each Node line:
//   node scripts/node-line/import-turns.cjs
// It writes six ES modules and six CommonJS files to a fresh temporary directory, counts setImmediate turns beside
// a loop that imports each for the first time and then three again, and prints one line for each format.
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

async function measure(directory, extension) {
  let turns = 0, counting = true;
  const tick = () => { turns += 1; if (counting) setImmediate(tick); };
  setImmediate(tick);
  const fresh = [], again = [];
  for (let at = 1; at <= 6; at += 1) { await import(pathToFileURL(join(directory, `m${at}.${extension}`)).href); fresh.push(turns); }
  for (let at = 1; at <= 3; at += 1) { await import(pathToFileURL(join(directory, `m${at}.${extension}`)).href); again.push(turns); }
  counting = false;
  return { fresh, again };
}

(async () => {
  const directory = mkdtempSync(join(tmpdir(), "import-turns-"));
  try {
    for (let at = 1; at <= 6; at += 1) {
      writeFileSync(join(directory, `m${at}.mjs`), `export default ${at};\n`);
      writeFileSync(join(directory, `m${at}.cjs`), `module.exports = ${at};\n`);
    }
    for (const [format, extension] of [["ES module", "mjs"], ["CommonJS", "cjs"]]) {
      const { fresh, again } = await measure(directory, extension);
      console.log(`${process.version} ${format}: loop turns after fresh imports 1..6: ${fresh.join(", ")}; after importing 1..3 again: ${again.join(", ")}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
})();
