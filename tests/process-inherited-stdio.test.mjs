import test from 'node:test';
import assert from 'node:assert/strict';
const { createContainer } = await import('../dist/index.mjs');

test('a parent inherits its own stderr after a fork has replaced the realm process', {timeout:10000}, async () => {
  const container = createContainer();
  container.vfs.mkdirSync('/parent', {recursive:true});
  container.vfs.mkdirSync('/other', {recursive:true});
  container.vfs.writeFileSync('/child.cjs', `process.stderr.write = () => { throw new Error('wrong inherited stream'); }; process.exit(0);`);
  container.vfs.writeFileSync('/writer.cjs', `process.stderr.write('PARENT-STDERR '+process.cwd()+'\\n');`);
  container.vfs.writeFileSync('/parent.cjs', `
    const {fork,spawn}=require('child_process');
    const first=fork('/child.cjs',[],{cwd:'/other',stdio:['ignore','ignore','ignore','ipc']});
    first.on('exit',()=>{
      process.stderr.write=()=>{throw Error('a JS stream override is not fd 2')};
      const second=spawn(process.execPath,['/writer.cjs'],{stdio:['ignore','ignore','inherit']});
      second.on('exit',code=>console.log('writer-exit',code));
    });
  `);
  try {
    const result=await container.run('node /parent.cjs',{processToken:'parent-inheritance',cwd:'/parent'});
    assert.equal(result.exitCode,0);
    assert.match(result.stdout,/writer-exit 0/);
    assert.match(result.stderr,/PARENT-STDERR \/parent/);
  } finally {container.serverBridge.close();}
});
