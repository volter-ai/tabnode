/**
 * The closure of Node's library as the engine vendors it: every builtin id a vendored file can require, at its top,
 * inside a function, or through the lazy forms Node's files use (`defineLazyProperties`, `exposeLazyInterfaces`,
 * `defineReplaceableLazyAttribute`), must be a vendored file or an id the engine answers, as every id Node's own files
 * require is in Node's builtin set. The build checks it where the vendored set is assembled (vite.lib.config.js) and
 * refuses a library with an id left unanswered. No import: the build bundles this with the set alone.
 */

/** A file's text with its comments removed, so an id a comment names is not a request. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1');
}

const REQUEST_FORMS = [
  /\brequire\(\s*'([^'$]+)'\s*\)/gu,
  /\bdefineLazyProperties\(\s*[^,]+,\s*'([^']+)'/gu,
  /\bexposeLazyInterfaces\(\s*[^,]+,\s*'([^']+)'/gu,
  /\bdefineReplaceableLazyAttribute\(\s*[^,]+,\s*'([^']+)'/gu,
];

/** The builtin ids a file of Node's library names as a module it requires. */
export function builtinRequests(text: string): string[] {
  const found = new Set<string>();
  const code = withoutComments(text);
  for (const form of REQUEST_FORMS) {
    for (const match of code.matchAll(form)) {
      const id = match[1]!.replace(/^node:/u, '');
      if (!id.startsWith('.') && !id.startsWith('/')) found.add(id);
    }
  }
  return [...found];
}

/** Each requested id that is neither vendored nor answered, with a file that requires it. */
export function unansweredBuiltins(sources: Readonly<Record<string, string>>, answered: Iterable<string>): Array<{ id: string; from: string }> {
  const known = new Set<string>([...Object.keys(sources), ...answered]);
  const missing = new Map<string, string>();
  for (const [from, text] of Object.entries(sources)) {
    for (const id of builtinRequests(text)) if (!known.has(id) && !missing.has(id)) missing.set(id, from);
  }
  return [...missing].map(([id, from]) => ({ id, from })).sort((a, b) => a.id.localeCompare(b.id));
}
