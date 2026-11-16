// internalBinding('cjs_lexer') without V8 (Tabnode ADR-0018 §7): Node v24.21.0's src/node_cjs_lexer.cc Parse over
// merve (deps/merve, the CommonJS export lexer Node links), through merve's own C interface (merve_c.h). The engine's
// half (src/node-lib/binding/cjs_lexer.ts) copies the source into the process's memory, reads each export's and
// re-export's name back, and makes the `[exports (a Set), reexports (an Array)]` Parse answers.
#include <stddef.h>
#include <stdint.h>
#include "merve_c.h"
#include "wrap.h"

// lexer::parse_commonjs of `length` bytes at `input`: the analysis, NULL where memory is out.
TABNODE_EXPORT(tabnode_cjs_parse) merve_analysis tabnode_cjs_parse(const char *input, size_t length) {
  return merve_parse_commonjs(input, length, NULL);
}

// Whether the analysis is a parse (Parse answers an empty result for one that is not), and its end.
TABNODE_EXPORT(tabnode_cjs_valid) int tabnode_cjs_valid(merve_analysis analysis) { return merve_is_valid(analysis) ? 1 : 0; }
TABNODE_EXPORT(tabnode_cjs_free) void tabnode_cjs_free(merve_analysis analysis) { merve_free(analysis); }

// The counts of exports and of re-exports.
TABNODE_EXPORT(tabnode_cjs_exports) int tabnode_cjs_exports(merve_analysis analysis) { return (int)merve_get_exports_count(analysis); }
TABNODE_EXPORT(tabnode_cjs_reexports) int tabnode_cjs_reexports(merve_analysis analysis) { return (int)merve_get_reexports_count(analysis); }

// The `index`th export's or re-export's name: its bytes' address into `out[0]` and their length into `out[1]`.
TABNODE_EXPORT(tabnode_cjs_name) void tabnode_cjs_name(merve_analysis analysis, int reexport, int index, uint32_t *out) {
  merve_string name = reexport ? merve_get_reexport_name(analysis, (size_t)index) : merve_get_export_name(analysis, (size_t)index);
  out[0] = (uint32_t)(uintptr_t)name.data;
  out[1] = (uint32_t)name.length;
}

// Metadata::Versions' `merve` (node_metadata.cc:131), MERVE_VERSION, as merve's C interface answers it.
TABNODE_EXPORT(tabnode_merve_version) const char *tabnode_merve_version(void) { return merve_get_version(); }
