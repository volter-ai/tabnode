// HANDLEWRAP (Tabnode ADR-0018 §3), the half of Node's src/handle_wrap.cc (Node v24.21.0) that is libuv's calls: a
// handle's JavaScript object (the engine's HandleWrap, src/node-lib/binding/handle_wrap.ts) keeps its state and names
// its uv_handle_t by its address in the process's memory, as Node's HandleWrap keeps state_ and handle_; each call
// here is the libuv call Node's makes once that state allows it. The handle's memory is its wrap's, freed when the
// wrap is collected after its close, as Node's BaseObject is (the engine's FinalizationRegistry, tabnode_free).
#include <uv.h>
#include "engine.h"

// HandleWrap::OnClose (handle_wrap.cc:135-157): the wrap is closed, and its close callback, where Close was given one,
// is made (tabnode_handle_closed); the callback's scope closes before the C returns to libuv.
static void on_close(uv_handle_t *handle) {
  if (tabnode_handle_closed(handle)) tabnode_drain();
}

// HandleWrap::Close (handle_wrap.cc:72-83), once the wrap's state is kInitialized.
__attribute__((export_name("tabnode_handle_close"))) void tabnode_handle_close(uv_handle_t *handle) {
  uv_close(handle, on_close);
}
// HandleWrap::Ref, Unref and HasRef (handle_wrap.cc:40-63), once the wrap is alive (IsAlive).
__attribute__((export_name("tabnode_handle_ref"))) void tabnode_handle_ref(uv_handle_t *handle) { uv_ref(handle); }
__attribute__((export_name("tabnode_handle_unref"))) void tabnode_handle_unref(uv_handle_t *handle) { uv_unref(handle); }
__attribute__((export_name("tabnode_handle_has_ref"))) int tabnode_handle_has_ref(const uv_handle_t *handle) {
  return uv_has_ref(handle);
}
