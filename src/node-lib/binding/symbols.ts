/**
 * `internalBinding('symbols')`: Node v24.21.0's per-isolate symbols (src/env_properties.h
 * PER_ISOLATE_SYMBOL_PROPERTIES), one of each a realm, each named as Node names it. `owner_symbol` is the engine's one
 * (owner-symbol.ts), which its handles carry; `handle_onclose`, `oninit` and `no_message_symbol` are the messaging
 * binding's (messaging.ts).
 */
import { handleOwnerSymbol } from './owner-symbol';
import { messagingSymbols } from './messaging';

// eslint-disable-next-line no-var, vars-on-top
var made: Readonly<Record<string, symbol>> | undefined;
/** Built on the first ask, for the reason `./index.ts` gives. */
export function perIsolateSymbols(): Readonly<Record<string, symbol>> {
  return made ??= Object.freeze({
  fs_use_promises_symbol: Symbol('fs_use_promises_symbol'),
  async_id_symbol: Symbol('async_id_symbol'),
  constructor_key_symbol: Symbol('constructor_key_symbol'),
  handle_onclose: messagingSymbols.handle_onclose,
  no_message_symbol: messagingSymbols.no_message_symbol,
  messaging_deserialize_symbol: Symbol('messaging_deserialize_symbol'),
  imported_cjs_symbol: Symbol('imported_cjs_symbol'),
  messaging_transfer_symbol: Symbol('messaging_transfer_symbol'),
  messaging_clone_symbol: Symbol('messaging_clone_symbol'),
  messaging_transfer_list_symbol: Symbol('messaging_transfer_list_symbol'),
  oninit: messagingSymbols.oninit,
  owner_symbol: handleOwnerSymbol,
  onpskexchange: Symbol('onpskexchange'),
  resource_symbol: Symbol('resource_symbol'),
  trigger_async_id_symbol: Symbol('trigger_async_id_symbol'),
  builtin_source_text_module_hdo: Symbol('builtin_source_text_module_hdo'),
  source_text_module_default_hdo: Symbol('source_text_module_default_hdo'),
  vm_context_no_contextify: Symbol('vm_context_no_contextify'),
  vm_dynamic_import_default_internal: Symbol('vm_dynamic_import_default_internal'),
  vm_dynamic_import_main_context_default: Symbol('vm_dynamic_import_main_context_default'),
  vm_dynamic_import_missing_flag: Symbol('vm_dynamic_import_missing_flag'),
  vm_dynamic_import_no_callback: Symbol('vm_dynamic_import_no_callback'),
  });
}
