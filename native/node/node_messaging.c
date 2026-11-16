// MESSAGEPORT (Tabnode ADR-0018 item 9): Node v24.21.0's src/node_messaging.cc MessagePort without V8, a HandleWrap
// (handle_wrap.c: close, ref, unref, hasRef, and OnClose, which frees it) over a uv_async_t of the process's loop. The
// port's queue, its sibling group and its messages are its V8 half (src/node-lib/binding/messaging.ts), as
// MessagePortData's are. A message's arrival is TriggerAsync, uv_async_send; libuv's callback is OnMessage, each
// message one callback into the engine (ReceiveMessage, then MakeCallback of the port's emitMessage) and that
// callback's scope closed after it. So a port holds the loop as Node's does: its uv_async_t is active from its making to
// its close, and referenced while its JavaScript (lib/internal/worker/io.js setupPortReferencing) has it so.
#include <stdlib.h>
#include <uv.h>
#include "engine.h"
#include "wrap.h"

// MessagePort::TriggerAsync (node_messaging.cc:697-700): none once the handle is closing.
static void trigger_async(uv_async_t *handle) {
  if (uv_is_closing((uv_handle_t *)handle)) return;
  if (uv_async_send(handle) != 0) abort();
}

// MessagePort::OnMessage(kNormalOperation) (node_messaging.cc:812-891): nothing for a detached port; else at most the
// messages queued when it began, and at least 1,000, each its own callback whose scope closes after it; the rest on
// the loop's next turn (TriggerAsync), and after a failed callback the next turn too, which the engine asks for.
static void on_message(uv_async_t *handle) {
  int32_t limit = tabnode_message_port_pending(handle);
  if (limit < 0) return;
  for (;;) {
    if (limit-- == 0) {
      trigger_async(handle);
      return;
    }
    int32_t received = tabnode_message_port_message(handle);
    if (received == 0) return;
    tabnode_drain();
    if (received != 1) return;
  }
}

// MessagePort's constructor (node_messaging.cc:662-676): its uv_async_t, CHECK_EQ(uv_async_init(...), 0), so the wrap
// is initialized when it is made. Node's `new` aborts where memory is out; so does this.
TABNODE_EXPORT(tabnode_message_port_new) uv_async_t *tabnode_message_port_new(void) {
  uv_async_t *handle = calloc(1, sizeof *handle);
  if (!handle || uv_async_init(uv_default_loop(), handle, on_message) != 0) abort();
  return handle;
}

// TriggerAsync, for a message the engine queued (MessagePortData::AddToIncomingQueue), a port given a queue that
// already holds messages (MessagePort::New) or a start with messages waiting (MessagePort::Start). Every poster is the
// process's one thread: a process's realm is its only one, and it has no worker threads.
TABNODE_EXPORT(tabnode_message_port_trigger) void tabnode_message_port_trigger(uv_async_t *handle) {
  trigger_async(handle);
}
