// /usr/bin/node (Tabnode ADR-0018 §2): Node's own start (src/node_main.cc, node::Start) without V8. libuv's default
// loop and its handles, the engine's bootstrap, then the loop as Node's SpinEventLoopInternal spins it
// (src/api/embed_helpers.cc:40-63, Node v24.21.0): uv_run, 'beforeExit' when the loop is not alive, again while it
// came alive, then 'exit' and its code. `main` calls uv_run itself, so the stack from _start to every drain is
// WebAssembly alone, as a JSPI suspension requires.
#include <uv.h>
#include "engine.h"
#include "env.h"

int main(int argc, char **argv) {
  uv_loop_t *loop = uv_default_loop();
  tabnode_initialize_libuv(loop);
  int status = tabnode_bootstrap(argc, argv);
  if (status != 0) return status;
  int more;
  do {
    uv_run(loop, UV_RUN_DEFAULT);
    more = uv_loop_alive(loop);
    if (more) continue;
    if (tabnode_before_exit() != 0) break;
    more = uv_loop_alive(loop);
  } while (more);
  return tabnode_exit();
}
