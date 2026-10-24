/** Actual compiled guest script text, scoped to its process and released with it.
 * Native Error positions refer to the transformed/wrapped script, not to an
 * invented position in the original file. Source-map remapping is separate. */
import { stackOverrideMap } from './stack-overrides';
const sources = new WeakMap<object, Map<string, string>>();
export function rememberCompiledSource(owner: object, source: string): void {
  const name = /(?:^|\n)\/\/# sourceURL=([^\r\n]+)\s*$/.exec(source)?.[1];
  if (!name) return;
  let files = sources.get(owner);
  if (!files) { files = new Map(); sources.set(owner, files); }
  files.set(name, source);
}
interface Site { getFileName?(): string | null; getScriptNameOrSourceURL?(): string | null;
  getLineNumber?(): number | null; getColumnNumber?(): number | null }
export function errorSourcePositions(owner: object, error: object) {
  // The existing native stack hook gives this one error its actual call sites.
  let sites: Site[] | undefined;
  const previousPrepare = (Error as any).prepareStackTrace;
  stackOverrideMap.set(error, (_error, captured) => {
    sites = captured as Site[];
    if (typeof previousPrepare === 'function') return previousPrepare(error, captured);
    const head = error instanceof Error ? Error.prototype.toString.call(error) : 'Error';
    return head + captured.map(site => `\n    at ${String(site)}`).join('');
  });
  const formatted = (error as { stack?: unknown }).stack;
  stackOverrideMap.delete(error);
  const first = sites?.[0];
  let name = first?.getFileName?.() ?? first?.getScriptNameOrSourceURL?.();
  let line = first?.getLineNumber?.();
  let column = first?.getColumnNumber?.();
  if (!first && typeof formatted === 'string') {
    // A host that eagerly materializes stack text can still provide its real
    // first frame. A custom stack formatter may not contain such a frame.
    const frame = formatted.split('\n').slice(1).map(text =>
      /(?:at\s+(?:.*?\()?|@)(.+?):(\d+):(\d+)\)?$/.exec(text.trim())).find(Boolean);
    if (frame) { name = frame[1]; line = Number(frame[2]); column = Number(frame[3]); }
  }
  const script = name ? sources.get(owner)?.get(name) : undefined;
  const sourceLine = script && line ? script.split(/\r?\n/)[line - 1] : undefined;
  if (sourceLine === undefined || !line || !column) {
    throw Object.assign(new Error('The engine has no captured source position for this error.'),
      { code: 'ERR_UNSUPPORTED_OPERATION', capability: 'errors.source-position' });
  }
  return { sourceLine, scriptResourceName: name, lineNumber: line, startColumn: column - 1 };
}
