/**
 * Node's `string_decoder`, which is Node's own `lib/string_decoder.js`.
 *
 * The engine had a hand-written stub built in `runtime.ts`: it decoded each
 * chunk on its own, so a multi-byte character split across two chunks came out
 * as two replacement characters. Every protocol VS Code's workbench speaks to
 * its extension host is UTF-8 over a socket, and a message that happened to be
 * cut inside a character was corrupted; `Readable.setEncoding` had nothing to
 * decode with at all.
 *
 * The method is Node's, transcribed over the engine's `Buffer`: a decoder holds
 * back the bytes of an incomplete sequence in `lastChar` and completes it with
 * the head of the next chunk. `lastChar`, `lastNeed` and `lastTotal` are Node's
 * own undocumented fields, which Node's test reads.
 *
 * Two departures from `lib/string_decoder.js`, both named where they are: the
 * held-back bytes are in a zeroed buffer rather than an uninitialised one, and
 * a string too long for V8 is refused by the input's size rather than by
 * building the string and failing.
 */
export interface StringDecoder {
    encoding: string;
    lastChar: Buffer;
    lastNeed: number;
    lastTotal: number;
    write(buffer: unknown): string;
    end(buffer?: unknown): string;
    text(buffer: Buffer, offset: number): string;
    fillLast(buffer: Buffer): string | undefined;
}
interface StringDecoderConstructor {
    new (encoding?: string): StringDecoder;
    (this: unknown, encoding?: string): void;
    prototype: StringDecoder;
}
export declare const StringDecoder: StringDecoderConstructor;
declare const _default: {
    StringDecoder: StringDecoderConstructor;
};
export default _default;
//# sourceMappingURL=string_decoder.d.ts.map