/**
 * `internalBinding('options')` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's src/node_options.cc
 * over its option table (options-table.ts), for Node's own `lib/internal/options.js`. The values are the defaults with
 * the run's options applied as Node's OptionsParser applies them: NODE_OPTIONS first (only what is allowed there),
 * then the command line's own (`execArgv`); `--name=value` or the next word for an option that takes a value, `--no-`
 * for a boolean, an alias expanded (`-r`, `-pe`, `--print <arg>`), dashes and underscores alike in a name, a string
 * list appended to, and each implication (Implies, ImpliesNot) set.
 *
 * Where this differs from Node:
 * - V8's own options are no option of V8's here: a page's engine takes no flags after it starts.
 * - The CA store is the image's bundle as `--use-openssl-ca` makes it (ADR-0016 §4), and `--tls-cipher-list`'s default
 *   is the one the `node` program compiled (DEFAULT_CIPHER_LIST_CORE, node_constants.h).
 * - An option the table does not hold, or a value of the wrong kind, is left where the engine's command line left it:
 *   the run's own refusals are the engine's (`launchNode`), not Node's `bad option` with exit 9.
 */
import { NODE_OPTIONS_TABLE } from './options-table';
import { constantsBinding } from '../../shims/constants';

/** OptionType (src/node_options.h). */
const types = { kNoOp: 0, kV8Option: 1, kBoolean: 2, kInteger: 3, kUInteger: 4, kString: 5, kHostPort: 6, kStringList: 7 };
/** OptionEnvvarSettings (src/node_options.h). */
const envSettings = { kAllowedInEnvvar: 0, kDisallowedInEnvvar: 1 };

type OptionRow = readonly [type: number, env: number, defaultIsTrue: boolean, help: string];
const OPTIONS = NODE_OPTIONS_TABLE.options as unknown as Readonly<Record<string, OptionRow>>;
const ALIASES = NODE_OPTIONS_TABLE.aliases as unknown as Readonly<Record<string, readonly string[]>>;

/** What the run gives the binding: its options as Node's parser takes them. */
export interface RunOptions {
  /** The command line's own options, `process.execArgv`. */
  readonly execArgv: readonly string[];
  /** NODE_OPTIONS's words, split as Node's ParseNodeOptionsEnvVar splits them. */
  readonly nodeOptions: readonly string[];
}

/** `--Foo_bar=x` as Node reads its name: dashes for underscores after the leading two, as the parser normalizes them. */
function normalized(name: string): string {
  if (!name.startsWith('--')) return name;
  return `--${name.slice(2).replace(/_/gu, '-')}`;
}

/** The run's option values: the defaults, then each option the run gave, in Node's order. */
export function optionValuesOf(run: RunOptions): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(NODE_OPTIONS_TABLE.values)) {
    values[name] = Array.isArray(value) ? [...value] : value;
  }
  values['--use-openssl-ca'] = true;
  values['[ssl_openssl_cert_store]'] = true;
  values['--tls-cipher-list'] = (constantsBinding().crypto as { defaultCoreCipherList: string }).defaultCoreCipherList;
  const implied = (name: string, on: boolean): void => {
    for (const [from, to, sets] of NODE_OPTIONS_TABLE.implies as unknown as Array<[string, string, boolean]>) {
      if (from !== name) continue;
      const target = OPTIONS[to];
      if (target && target[0] === types.kBoolean) values[to] = on ? sets : values[to];
    }
  };
  const apply = (words: readonly string[], fromEnvironment: boolean): void => {
    const queue = [...words];
    while (queue.length > 0) {
      let word = queue.shift()!;
      if (word === '--') break;
      if (!word.startsWith('-') || word === '-') break;
      let inline: string | undefined;
      const equals = word.startsWith('--') ? word.indexOf('=') : -1;
      if (equals > 0) { inline = word.slice(equals + 1); word = word.slice(0, equals); }
      let name = normalized(word);
      // An alias: `-pe` is `--print --eval`; `--print <arg>` stands for the option with a value after it.
      const expansion = ALIASES[name] ?? (inline === undefined && queue.length > 0 ? ALIASES[`${name} <arg>`] : undefined);
      if (expansion) {
        const [first, ...rest] = expansion;
        queue.unshift(...rest);
        name = first!;
      }
      let negated = false;
      if (!OPTIONS[name] && name.startsWith('--no-')) {
        const positive = `--${name.slice(5)}`;
        if (OPTIONS[positive]?.[0] === types.kBoolean) { name = positive; negated = true; }
      }
      const option = OPTIONS[name];
      if (!option) continue;
      if (fromEnvironment && option[1] !== envSettings.kAllowedInEnvvar) continue;
      switch (option[0]) {
        case types.kBoolean:
          values[name] = !negated;
          implied(name, !negated);
          break;
        case types.kInteger:
        case types.kUInteger:
        case types.kString:
        case types.kHostPort:
        case types.kStringList: {
          const value = inline ?? queue.shift();
          if (value === undefined) break;
          if (option[0] === types.kStringList) (values[name] as string[]).push(value);
          else if (option[0] === types.kString || option[0] === types.kHostPort) values[name] = value;
          else values[name] = Number.parseInt(value, 10);
          implied(name, true);
          break;
        }
        default:
          break;
      }
    }
  };
  apply(run.nodeOptions, true);
  apply(run.execArgv, false);
  return values;
}

export function createOptionsBinding(run: RunOptions): Record<string, unknown> {
  let values: Record<string, unknown> | undefined;
  const valuesNow = (): Record<string, unknown> => values ??= optionValuesOf(run);
  return {
    // GetCLIOptionsValues: every option with a field, by name, as a plain object.
    getCLIOptionsValues(): Record<string, unknown> {
      const now = valuesNow();
      const copy: Record<string, unknown> = { __proto__: null } as unknown as Record<string, unknown>;
      for (const [name, value] of Object.entries(now)) copy[name] = Array.isArray(value) ? [...value] : value;
      return copy;
    },
    // GetCLIOptionsInfo: `options`, a Map of each option's helpText, envVarSettings, type and
    // defaultIsTrue; `aliases`, a Map of each alias to its expansion.
    getCLIOptionsInfo(): { options: Map<string, Record<string, unknown>>; aliases: Map<string, string[]> } {
      const options = new Map<string, Record<string, unknown>>();
      for (const [name, [type, env, defaultIsTrue, helpText]] of Object.entries(OPTIONS)) {
        options.set(name, { helpText, envVarSettings: env, type, defaultIsTrue });
      }
      const aliases = new Map<string, string[]>();
      for (const [name, expansion] of Object.entries(ALIASES)) aliases.set(name, [...expansion]);
      return { options, aliases };
    },
    // GetOptionsAsFlags (node_options.cc:2013): the options as flags: a boolean that differs from its default, every number,
    // a non-empty string, each string of a list, a host and port that are not empty; never an internal `[...]`
    // option, a V8 option or a no-op.
    getOptionsAsFlags(): string[] {
      const now = valuesNow();
      const flags: string[] = [];
      for (const [name, [type, , defaultIsTrue]] of Object.entries(OPTIONS)) {
        if (name === '' || name.startsWith('[') || type === types.kNoOp || type === types.kV8Option) continue;
        const value = now[name];
        if (type === types.kBoolean) {
          if (defaultIsTrue && value === false) flags.push(`--no-${name.slice(2)}`);
          else if (!defaultIsTrue && value === true) flags.push(name);
        } else if (type === types.kInteger || type === types.kUInteger) flags.push(`${name}=${value}`);
        else if (type === types.kString) { if (value) flags.push(`${name}=${value}`); }
        else if (type === types.kStringList) { for (const each of value as string[]) flags.push(`${name}=${each}`); }
        else if (type === types.kHostPort && value) flags.push(`${name}=${value}`);
      }
      return flags;
    },
    // GetEmbedderOptions: the engine starts Node as `node` does, with none of the embedder's switches.
    getEmbedderOptions: () => ({ shouldNotRegisterESMLoader: false, noGlobalSearchPaths: false, noBrowserGlobals: false, hasEmbedderPreload: false }),
    // GetEnvOptionsInputType and GetNamespaceOptionsInputType: the config file's schema.
    getEnvOptionsInputType: () => JSON.parse(JSON.stringify(NODE_OPTIONS_TABLE.envInputTypes)),
    getNamespaceOptionsInputType: () => new Map(JSON.parse(JSON.stringify(NODE_OPTIONS_TABLE.namespaceInputTypes)) as Array<[string, unknown]>),
    envSettings,
    types,
  };
}

/** NODE_OPTIONS split into words as ParseNodeOptionsEnvVar splits them: spaces separate, double quotes group, a backslash escapes inside quotes. */
export function nodeOptionsWords(text: string | undefined): string[] {
  const words: string[] = [];
  if (!text) return words;
  let current = '';
  let quoted = false;
  let any = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted && character === '\\' && index + 1 < text.length) { current += text[++index]; continue; }
    if (character === '"') { quoted = !quoted; any = true; continue; }
    if (character === ' ' && !quoted) {
      if (any || current !== '') words.push(current);
      current = ''; any = false;
      continue;
    }
    current += character;
  }
  if (any || current !== '') words.push(current);
  return words;
}

/**
 * ProcessGlobalArgs' split of the command line (src/node.cc, OptionsParser::Parse): the options before the script,
 * each with its value where its type takes one (`--name=value` or the next word), are `execArgv`; the program's name,
 * the script and its arguments are `argv`; `--` ends the options. An option the table does not hold, or one missing
 * its value, is Node's `bad option` / `requires an argument`.
 */
export function splitCommandLine(argv: readonly string[]): { argv: string[]; execArgv: string[] } | { error: string } {
  const execArgv: string[] = [];
  let index = 1;
  while (index < argv.length) {
    const word = argv[index]!;
    if (word === '--') { index += 1; break; }
    if (!word.startsWith('-') || word === '-') break;
    const equals = word.startsWith('--') ? word.indexOf('=') : -1;
    let name = normalized(equals > 0 ? word.slice(0, equals) : word);
    const hasInline = equals > 0;
    const expansion = ALIASES[name] ?? (!hasInline ? ALIASES[`${name} <arg>`] : undefined);
    if (expansion) name = expansion[expansion.length - 1]!;
    if (!OPTIONS[name] && name.startsWith('--no-') && OPTIONS[`--${name.slice(5)}`]?.[0] === types.kBoolean) name = `--${name.slice(5)}`;
    const option = OPTIONS[name];
    if (!option) return { error: `bad option: ${word}` };
    execArgv.push(word);
    index += 1;
    const takesValue = option[0] === types.kInteger || option[0] === types.kUInteger || option[0] === types.kString
      || option[0] === types.kHostPort || option[0] === types.kStringList;
    if (takesValue && !hasInline) {
      if (index >= argv.length) return { error: `${word} requires an argument` };
      execArgv.push(argv[index]!);
      index += 1;
    }
  }
  return { argv: [argv[0] ?? 'node', ...argv.slice(index)], execArgv };
}
