// What a process does as it ends. Under Node and as a guest of the built engine the output is the same:
//   node scripts/exit-on-finish.cjs            printed / exit 0 / written     (ends by simply finishing)
//   node scripts/exit-on-finish.cjs timer      timer / exit 0 / written       (ends when its loop drains)
//   node scripts/exit-on-finish.cjs silent     exit 0 / written               (prints nothing before the end)
//   node scripts/exit-on-finish.cjs exit       printed / exit 0, status 3     (process.exit; the listener sets another status)
const how = process.argv[2] ?? 'printed';
process.on('exit', (code) => {
  console.log('exit ' + code);
  if (how === 'exit') process.exit(3);
  process.stdout.write('written\n');
});
if (how === 'timer') setTimeout(() => console.log('timer'), 50);
else if (how !== 'silent') console.log('printed');
if (how === 'exit') process.exit(0);
