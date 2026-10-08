// A program that prints and then simply finishes runs its `exit` listeners, as one that prints nothing does.
// Under Node and as a guest of the built engine: `printed` then `exit 0`.
process.on('exit', (code) => console.log('exit ' + code));
console.log('printed');
