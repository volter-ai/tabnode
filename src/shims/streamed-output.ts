/**
 * What of a command's collected output was not already streamed.
 *
 * The engine's shell collects a command line's output as one text at its end;
 * a `node` in it (or a background job) also streams its own as it writes. A
 * caller that forwarded the streamed pieces sends the rest at the end. Cutting
 * the collected text at the streamed length assumed the streamed pieces came
 * first: `echo "pid=1"; node -e "console.log('fg out')"; echo end`, spawned by
 * a guest, reached it as `fg out\ng out\nend\n` -- the builtin's line lost and
 * the node's half repeated. Each streamed piece is taken out where it stands in
 * the collected text, in order, and what is left is the rest; a piece the text
 * does not hold is passed over.
 */
export function unstreamedOutput(total: string, streamed: readonly string[]): string {
  let rest = total;
  let cursor = 0;
  for (const piece of streamed) {
    if (!piece) continue;
    const at = rest.indexOf(piece, cursor);
    if (at < 0) continue;
    rest = rest.slice(0, at) + rest.slice(at + piece.length);
    cursor = at;
  }
  return rest;
}
