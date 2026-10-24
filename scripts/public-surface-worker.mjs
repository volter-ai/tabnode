import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshot } from './surface-snapshot.mjs';
const args = JSON.parse(process.argv[2]);
const hostExit = process.exit.bind(process);
const hostVersion = process.version;
const save = (result) => fs.writeFileSync(args.output, JSON.stringify(result) + '\n');
try {
  if (args.mode === 'node') {
    const require = createRequire(import.meta.url);
    save({ module: args.module, hostVersion, snapshot: snapshot(require(`node:${args.module.replace(/^node:/, '')}`)) });
  } else {
    const { createContainer } = await import(pathToFileURL(resolve(args.engine)).href);
    // Mirror node-tests.mjs: the engine must execute the guest rather than
    // dispatching to the host Node binary.
    if (typeof globalThis.window === 'undefined') globalThis.window = { navigator: { serviceWorker: {} } };
    const container = createContainer();
    const script = `/surface.cjs`;
    container.vfs.writeFileSync(script, `const snapshot = ${snapshot.toString()};\nconst fs = require('fs');\ntry { fs.writeFileSync('/surface.json', JSON.stringify({ module: ${JSON.stringify(args.module)}, snapshot: snapshot(require(${JSON.stringify('node:' + args.module.replace(/^node:/, ''))})) })); } catch (error) { fs.writeFileSync('/surface.json', JSON.stringify({ module: ${JSON.stringify(args.module)}, error: { code: error.code, message: error.message } })); }\n`);
    const result = await container.run(`node ${script}`, { onStdout: () => {}, onStderr: () => {} });
    if (container.vfs.existsSync('/surface.json')) save(JSON.parse(container.vfs.readFileSync('/surface.json', 'utf8')));
    else save({ module: args.module, error: { message: result.stderr || `guest exited ${result.exitCode} before recording exports` } });
  }
  hostExit(0);
} catch (error) { save({ module: args.module, error: { code: error.code, message: error.message }, ...(args.mode === 'engine' ? { engineFailed: true } : {}) }); hostExit(0); }
