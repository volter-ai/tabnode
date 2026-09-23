/**
 * Apply non-overlapping edits in descending source order. The AST visitors
 * decide the replacements; assembly must not copy a large module once per
 * reference. For equal-position insertions, later edits appear before earlier
 * ones, matching the former repeated slice/concatenate operation.
 */
export function applySourceEdits(
  source: string,
  edits: readonly (readonly [start: number, end: number, text: string])[],
): string {
  if (edits.length === 0) return source;
  const chunks: string[] = [];
  let cursor = source.length;
  for (const [start, end, text] of edits) {
    chunks.push(source.slice(end, cursor), text);
    cursor = start;
  }
  chunks.push(source.slice(0, cursor));
  return chunks.reverse().join('');
}
