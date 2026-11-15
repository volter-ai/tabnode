// /usr/bin/node (Tabnode ADR-0018 §2): Node's own start (src/node_main.cc, node::Start) without V8. libuv's default
// loop and its handles, the engine's bootstrap, then the loop as Node's SpinEventLoopInternal spins it
// (src/api/embed_helpers.cc:40-63, Node v24.21.0): uv_run, 'beforeExit' when the loop is not alive, again while it
// came alive, then 'exit' and its code. `main` calls uv_run itself, so the stack from _start to every drain is
// WebAssembly alone, as a JSPI suspension requires. Each call into the engine that Node makes inside a callback scope
// is followed by that scope's close, a drain: the bootstrap's (StartExecution, src/node.cc:290-294) and each process
// event's (ProcessEmit's MakeCallback, src/node_process_events.cc:48-61).
#include <uv.h>
#include "engine.h"
#include "env.h"

int main(int argc, char **argv) {
  uv_loop_t *loop = uv_default_loop();
  tabnode_initialize_libuv(loop);
  int status = tabnode_bootstrap(argc, argv);
  tabnode_drain();
  if (status != 0) return status;
  int more;
  do {
    uv_run(loop, UV_RUN_DEFAULT);
    more = uv_loop_alive(loop);
    if (more) continue;
    int stopping = tabnode_before_exit();
    tabnode_drain();
    if (stopping) break;
    more = uv_loop_alive(loop);
  } while (more);
  // EmitProcessExitInternal (src/api/hooks.cc:61-93): 'exit', its scope's close, then the code its listeners left.
  tabnode_emit_exit();
  tabnode_drain();
  return tabnode_exit_code();
}
