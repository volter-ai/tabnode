/** Portable, data-only formatting instructions; capture owns the scalar inputs. */
interface TraceValue {
  $trace: "value.v1";
  operation: "round" | "round-fields" | "rows" | "sum" | "sum-fields" | "entries" | "quantile" | "sum-values" | "text" | "merge" | "image-waits";
  value: unknown;
  options: Record<string, unknown>;
}
export interface TraceRowsOptions {
  orderBy?: string;
  limit?: number;
  columns?: readonly string[];
  round?: readonly string[];
  omit?: readonly string[];
  trimUndefined?: boolean;
  ascending?: boolean;
  singleColumn?: boolean;
  where?: { column: string; min: number; round?: boolean };
}
const deferred = (operation: TraceValue["operation"], value: unknown, options: Record<string, unknown> = {}): TraceValue =>
  ({ $trace: "value.v1", operation, value, options });
export const traceRound = (value: number | readonly number[], digits = 0): unknown => deferred("round", value, { digits });
export const traceRoundFields = (value: Readonly<Record<string, number>>, digits = 0, suffixes?: readonly string[]): unknown =>
  deferred("round-fields", value, { digits, suffixes });
export const traceRows = (value: readonly Readonly<Record<string, unknown>>[], options: TraceRowsOptions = {}): unknown =>
  deferred("rows", value, { ...options });
export const traceSum = (value: readonly Readonly<Record<string, unknown>>[], column: string, options: { minus?: string | number; positiveColumn?: string; round?: boolean } = {}): unknown =>
  deferred("sum", value, { column, ...options });
export const traceSumFields = (value: readonly Readonly<Record<string, unknown>>[], column: string): unknown =>
  deferred("sum-fields", value, { column });
export const traceEntries = (value: unknown): unknown => deferred("entries", value);
export const traceQuantile = (value: readonly number[], fraction: number, digits = 0): unknown => deferred("quantile", value, { fraction, digits });
export const traceSumValues = (value: readonly number[], digits = 0): unknown => deferred("sum-values", value, { digits });
export const traceText = (value: readonly unknown[]): unknown => deferred("text", value);

export const traceMerge = (...value: readonly unknown[]): unknown => deferred("merge", value);
export const traceImageWaits = (files: Array<[number, number, string]>, waited: readonly { index: number; offset: number; raw: number; ms: number; parked: boolean }[], own: boolean): unknown =>
  deferred("image-waits", { files, waited, own });

/** JSON's replacer runs these operations only at the evidence owner's drain. */
export function traceValueReplacer(_key: string, input: unknown): unknown {
  if (!input || typeof input !== "object" || (input as TraceValue).$trace !== "value.v1") return input;
  const { operation, options } = input as TraceValue;
  const value = traceValueReplacer("", (input as TraceValue).value);
  if (operation === "merge") return Object.assign({}, ...(value as unknown[]).map(each => traceValueReplacer("", each)));
  if (operation === "image-waits") {
    const { files, waited, own } = value as { files: Array<[number, number, string]>; waited: Array<{ index: number; offset: number; raw: number; ms: number; parked: boolean }>; own: boolean };
    files.sort((left, right) => left[0] - right[0]);
    const byDirectory = new Map<string, [number, number]>();
    let ms = 0, parked = 0, unnamed = 0;
    const unnamedRanges: Array<[number, number, number]> = [];
    const each = waited.map(wait => {
      ms += wait.ms; if (wait.parked) parked += 1;
      let low = 0, high = files.length;
      while (low < high) { const mid = (low + high) >>> 1; if (files[mid]![1] <= wait.offset) low = mid + 1; else high = mid; }
      const paths: string[] = [];
      for (let at = low; at < files.length && files[at]![0] < wait.offset + wait.raw; at += 1) paths.push(files[at]![2]);
      if (!paths.length) { unnamed += 1; if (unnamedRanges.length < 8) unnamedRanges.push([wait.index, wait.offset, wait.raw]); }
      for (const directory of new Set(paths.map(path => path.split("/").slice(0, 5).join("/")))) {
        const held = byDirectory.get(directory) ?? [0, 0]; held[0] += 1; held[1] += wait.ms; byDirectory.set(directory, held);
      }
      return { index: wait.index, ms: Math.round(wait.ms), parked: wait.parked, files: paths.length, paths: paths.slice(0, 4) };
    });
    return { waits: waited.length, ms: Math.round(ms), parked, unnamed, unnamedRanges,
      filesLookedThrough: { own, count: files.length, from: files[0]?.[0] ?? null, to: files[files.length - 1]?.[1] ?? null },
      byDirectory: [...byDirectory].sort((left, right) => right[1][1] - left[1][1]).slice(0, 16).map(([directory, [count, time]]) => [directory, count, Math.round(time)]),
      longest: each.sort((left, right) => right.ms - left.ms).slice(0, 12) };
  }
  if (operation === "entries") return Object.fromEntries(value as readonly (readonly [string, unknown])[]);
  if (operation === "text") return (value as readonly unknown[]).map(part => String(traceValueReplacer("", part))).join("");
  if (operation === "quantile" || operation === "sum-values") {
    const numbers = value as readonly number[], scale = 10 ** Number(options.digits);
    const number = operation === "sum-values" ? numbers.reduce((sum, each) => sum + each, 0)
      : [...numbers].sort((left, right) => left - right)[Math.min(numbers.length - 1, Math.floor(numbers.length * Number(options.fraction)))];
    return Math.round(number! * scale) / scale;
  }
  if (operation === "round") {
    const scale = 10 ** Number(options.digits);
    const round = (number: number): number => Math.round(number * scale) / scale;
    return Array.isArray(value) ? value.map(round) : round(Number(value));
  }
  if (operation === "round-fields") {
    const scale = 10 ** Number(options.digits);
    const suffixes = options.suffixes as readonly string[] | undefined;
    return Object.fromEntries(Object.entries(value as Record<string, number>).map(([key, number]) =>
      [key, !suffixes || suffixes.some(suffix => key.endsWith(suffix)) ? Math.round(number * scale) / scale : number]));
  }
  const rows = value as readonly Record<string, unknown>[];
  if (operation === "sum") {
    let sum = 0;
    for (const row of rows) {
      if (options.positiveColumn !== undefined && Number(row[String(options.positiveColumn)]) <= 1) continue;
      sum += Number(row[String(options.column)]) - (typeof options.minus === "string" ? Number(row[options.minus]) : Number(options.minus ?? 0));
    }
    return options.round ? Math.round(sum) : sum;
  }
  if (operation === "sum-fields") {
    const sums: Record<string, number> = {};
    for (const row of rows) for (const [key, number] of Object.entries(row[String(options.column)] as Record<string, number>)) sums[key] = (sums[key] ?? 0) + number;
    return sums;
  }
  const where = options.where as TraceRowsOptions["where"];
  const ordered = where ? rows.filter(row => (where.round ? Math.round(Number(row[where.column])) : Number(row[where.column])) >= where.min) : [...rows];
  if (options.orderBy !== undefined) ordered.sort((left, right) => (options.ascending ? -1 : 1) * (Number(right[String(options.orderBy)]) - Number(left[String(options.orderBy)])));
  const selected = options.limit === undefined ? ordered : ordered.slice(0, Number(options.limit));
  const columns = options.columns as readonly string[] | undefined, round = options.round as readonly string[] | undefined;
  return selected.map(row => {
    const fields = columns ?? Object.keys(row).filter(key => !(options.omit as readonly string[] | undefined)?.includes(key));
    const values = fields.map(key => round?.includes(key) ? Math.round(Number(row[key])) : row[key]);
    if (options.trimUndefined) while (values.length && values.at(-1) === undefined) values.pop();
    return columns ? options.singleColumn ? values[0] : values : Object.fromEntries(fields.map((key, index) => [key, values[index]]));
  });
}
