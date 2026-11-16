// /usr/bin/node (Tabnode ADR-0018 §2): Node's own start (src/node_main.cc, node::Start) without V8. libuv's default
// loop and its handles, the engine's bootstrap, then the loop as Node's SpinEventLoopInternal spins it
// (src/api/embed_helpers.cc:40-63, Node v24.21.0): uv_run, 'beforeExit' when the loop is not alive, again while it
// came alive, then 'exit' and its code. `main` calls uv_run itself, so the stack from _start to every drain is
// WebAssembly alone, as a JSPI suspension requires. Each call into the engine that Node makes inside a callback scope
// is followed by that scope's close, a drain: the bootstrap's (StartExecution, src/node.cc:290-294) and each process
// event's (ProcessEmit's MakeCallback, src/node_process_events.cc:48-61). PlatformInit's standard streams and signal
// dispositions come first (stdio.c), as InitializeOncePerProcess makes them before anything runs, then its reading of
// the command line and NODE_OPTIONS by Node's own parser (node_options.cc), where a bad option ends the process before
// the engine starts, and TearDownOncePerProcess's reset last, as node::Start's scope leaves it (src/node.cc:1592-1599), whatever the run
// answers.
#include <uv.h>
#include "engine.h"
#include "env.h"

void tabnode_platform_init(void);
void tabnode_platform_teardown(void);
int tabnode_initialize_node_with_args(int argc, char **argv, int *early_return);

static int run(int argc, char **argv) {
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

int main(int argc, char **argv) {
  // StartInternal (src/node.cc:1573-1577): libuv takes the vector, which its process title is then written over.
  argv = uv_setup_args(argc, argv);
  tabnode_platform_init();
  // InitializeOncePerProcessInternal (src/node.cc:1113-1175): the command line read, its errors reported, and the
  // process's end where it ends there (node_options.cc) before the engine starts.
  int early_return = 0;
  int status = tabnode_initialize_node_with_args(argc, argv, &early_return);
  if (!early_return) status = run(argc, argv);
  tabnode_platform_teardown();
  return status;
}
