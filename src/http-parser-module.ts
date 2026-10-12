import { traceReadingRequested, traceOutput } from './trace-output';
/**
 * llhttp's code is immutable and structured-cloneable; its instance, memory
 * and callbacks belong to the realm that runs the guest. The worker that
 * creates guest realms prepares this once at engine initialization, then
 * sends the module in each realm's RuntimeOptions.httpParserModule.
 */
import { LLHTTP_WASM_BASE64 } from './node-lib/binding/llhttp-wasm';

// Hoisted storage also works through the engine's builtin import cycles.
var compilation: Promise<WebAssembly.Module> | undefined;
var suppliedModule: WebAssembly.Module | undefined;
var compilations: number | undefined;

/**
 * Compile llhttp asynchronously once per engine load, before starting realms.
 * Await this in the realm-creating worker and structured-clone the result to
 * each guest worker. No parser is instantiated or run on this thread.
 */
export function prepareHttpParserModule(): Promise<WebAssembly.Module> {
  // A worker that received the module can give it to its own child realms.
  if (suppliedModule !== undefined) return Promise.resolve(suppliedModule);
  return compilation ??= compile();
}

async function compile(): Promise<WebAssembly.Module> {
  try {
    compilations = (compilations ?? 0) + 1;
    const binary = Uint8Array.from(atob(LLHTTP_WASM_BASE64), (character) => character.charCodeAt(0));
    const module = await WebAssembly.compile(binary);
    // A count, without timings: this line appears once in the creating
    // worker, beside one install line in each of its N receiving realms.
    if (traceReadingRequested()) traceOutput("[boot-trace]", { event: 'llhttp-module', where: 'compile', compiles: compilations });
    return module;
  } catch (error) {
    throw httpParserUnavailable(error);
  }
}

/** Install only the code; the binding still makes its own instance lazily. */
export function installHttpParserModule(module: WebAssembly.Module): void {
  suppliedModule = module;
  if (traceReadingRequested()) traceOutput("[boot-trace]", { event: 'llhttp-module', where: 'install' });
}

/** The synchronous binding's handoff, absent for a standalone realm. */
export function suppliedHttpParserModule(): WebAssembly.Module | undefined {
  return suppliedModule;
}

/** Keep the parser's existing refusal and cause for either compile path. */
export function httpParserUnavailable(error: unknown): Error {
  return Object.assign(new Error(
    'http: llhttp could not be compiled in this realm. A browser refuses a synchronous ' +
    'WebAssembly compile of more than 4 KB on the main thread; the engine parses HTTP ' +
    'where it runs a guest, which is a worker.',
  ), { cause: error, code: 'ERR_HTTP_PARSER_UNAVAILABLE' });
}
