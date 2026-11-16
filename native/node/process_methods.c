// process._kill (Tabnode ADR-0018 item 8): Node v24.21.0's src/node_process_methods.cc Kill (185-209) without V8:
// uv_kill of the pid and the signal V8's Int32Value gave, its answer libuv's. Where the signal is likely to end the
// process itself (a positive signal to its pid, its group or every process, with no started Signal on it), Node first
// runs the Environment's at-exit callbacks (RunAtExit, 198-205); Node's only callers of AtExit are its inspector agent
// and its profiler (inspector_agent.cc:879, inspector_profiler.cc:491), which the engine has neither of, so the process
// has none to run and the condition decides nothing.
#include <uv.h>
#include "wrap.h"

TABNODE_EXPORT(tabnode_kill) int tabnode_kill(int pid, int sig) { return uv_kill(pid, sig); }
