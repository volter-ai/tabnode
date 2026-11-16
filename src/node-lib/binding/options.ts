/**
 * `internalBinding('options')` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's src/node_options.cc,
 * its option table, its parser and its answers compiled into the program (native/node/node_start.cc), which reads
 * the command line and NODE_OPTIONS in `main`, as InitializeOncePerProcess does, before the engine starts. Each
 * function here makes of the program's answer what Node's makes of its values: getCLIOptionsValues a null-prototype
 * object, getCLIOptionsInfo `{ options, aliases }` with both Maps SafeMaps, getOptionsAsFlags an array,
 * getEnvOptionsInputType an object and getNamespaceOptionsInputType a Map of objects.
 */
import { libnode } from './libnode';
import { mallocAnswer } from './openssl';

/** OptionType (src/node_options.h), as Initialize defines it (node_options.cc:2149-2158). */
const types = { kNoOp: 0, kV8Option: 1, kBoolean: 2, kInteger: 3, kUInteger: 4, kString: 5, kHostPort: 6, kStringList: 7 };
/** OptionEnvvarSettings (src/node.h), as Initialize defines it (2143-2147). */
const envSettings = { kAllowedInEnvvar: 0, kDisallowedInEnvvar: 1 };

type Answer = 'tabnode_process_args' | 'tabnode_cli_options_values' | 'tabnode_cli_options_info' | 'tabnode_options_as_flags'
  | 'tabnode_env_options_input_type' | 'tabnode_namespace_options_input_type';

const decoder = new TextDecoder();

/** A program answer's JSON, read. */
function answer<T>(name: Answer): T {
  const exports = libnode().exports;
  const bytes = mallocAnswer((lengthAt) => exports[name](lengthAt));
  if (bytes === null) throw new Error(`options: the program gave no answer to ${name}`);
  return JSON.parse(decoder.decode(bytes)) as T;
}

/** The process's arguments as the program's parser left them: the program's name, the script and its arguments, and the options. */
export function processArgs(): { args: string[]; execArgs: string[] } {
  return answer('tabnode_process_args');
}

/** AddOptionTypeToObject's object (node_options.cc:314-387): each option's null-prototype `{ type, description }`. */
function optionTypes(entries: Array<[name: string, type: string, description: string]>): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const [name, type, description] of entries) object[name] = { __proto__: null, type, description };
  return object;
}

export function createOptionsBinding(safeMapPrototype: object): Record<string, unknown> {
  return {
    // GetCLIOptionsValues (1685-1805).
    getCLIOptionsValues(): Record<string, unknown> {
      const values = Object.create(null) as Record<string, unknown>;
      for (const [name, value] of answer<Array<[string, unknown?]>>('tabnode_cli_options_values')) {
        values[name] = value !== null && typeof value === 'object' && !Array.isArray(value) ? { __proto__: null, ...value } : value;
      }
      return values;
    },
    // GetCLIOptionsInfo (1807-1877).
    getCLIOptionsInfo(): { options: Map<string, unknown>; aliases: Map<string, string[]> } {
      const info = answer<{ options: Array<[string, string, number, number, boolean]>; aliases: Array<[string, string[]]> }>('tabnode_cli_options_info');
      const options = new Map<string, unknown>();
      for (const [name, helpText, envVarSettings, type, defaultIsTrue] of info.options) {
        options.set(name, { __proto__: null, helpText, envVarSettings, type, defaultIsTrue });
      }
      Object.setPrototypeOf(options, safeMapPrototype);
      const aliases = new Map<string, string[]>(info.aliases);
      Object.setPrototypeOf(aliases, safeMapPrototype);
      return { __proto__: null, options, aliases } as unknown as { options: Map<string, unknown>; aliases: Map<string, string[]> };
    },
    // GetOptionsAsFlags (2013-2120).
    getOptionsAsFlags: (): string[] => answer<string[]>('tabnode_options_as_flags'),
    // GetEmbedderOptions (1879-1906): the program starts as `node` does, with none of an embedder's switches.
    getEmbedderOptions: () => ({ __proto__: null, shouldNotRegisterESMLoader: false, noGlobalSearchPaths: false, noBrowserGlobals: false, hasEmbedderPreload: false }),
    // GetEnvOptionsInputType (1914-1945).
    getEnvOptionsInputType: (): Record<string, unknown> => optionTypes(answer('tabnode_env_options_input_type')),
    // GetNamespaceOptionsInputType (1952-2011).
    getNamespaceOptionsInputType(): Map<string, Record<string, unknown>> {
      const namespaces = new Map<string, Record<string, unknown>>();
      for (const [name, entries] of answer<Array<[string, Array<[string, string, string]>]>>('tabnode_namespace_options_input_type')) {
        namespaces.set(name, optionTypes(entries));
      }
      return namespaces;
    },
    envSettings,
    types,
  };
}
