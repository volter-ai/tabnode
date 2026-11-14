/**
 * `internalBinding('string_decoder')`: the native half under Node's own `lib/string_decoder.js`.
 *
 * Node v24.21.0's `src/string_decoder.cc`, ported as `./buffer.ts` ports `node_buffer.cc`. A decoder's whole state
 * is the `kSize`-byte Buffer `lib/string_decoder.js` allocates for it (`this[kNativeDecoder] = Buffer.alloc(kSize)`,
 * `src/string_decoder.h` `StringDecoder::state_`): the bytes of an incomplete character in `[0, 4)`, the bytes still
 * missing at 4, the bytes buffered at 5, the encoding at 6. `decode` and `flush` are functions of that buffer and
 * their input, as `DecodeData` and `FlushData` are; nothing is held here between calls.
 *
 * A string is made as `MakeString` makes it, through `buffer`'s slices (`./buffer.ts`): UTF-8 as V8's `NewFromUtf8`
 * makes it (each maximal ill-formed subpart one U+FFFD, a U+FEFF kept), latin1 one code unit per byte, UTF-16LE the
 * code units as they are (a lone surrogate kept, as a held half pair is flushed), and the rest as
 * `StringBytes::Encode` writes them.
 */
import {
  ASCII, UTF8, BASE64, UCS2, LATIN1, HEX, BUFFER, BASE64URL, kStringMaxLength,
  utf8Slice, asciiSlice, latin1Slice, ucs2Slice, hexSlice, base64Slice, base64urlSlice,
} from './buffer';

/** `StringDecoder::Fields` (src/string_decoder.h). */
const kIncompleteCharactersStart = 0;
const kIncompleteCharactersEnd = 4;
const kMissingBytes = 4;
const kBufferedBytes = 5;
const kEncodingField = 6;
const kNumFields = 7;
/** `sizeof(StringDecoder)`: `uint8_t state_[kNumFields]`. */
const kSize = kNumFields;

/** node_errors.h `ERR_STRING_TOO_LONG(isolate)`: an `Error` with its code, V8's longest string in the message. */
function stringTooLong(): Error {
  return Object.assign(new Error(`Cannot create a string longer than 0x${kStringMaxLength.toString(16)} characters`),
    { code: 'ERR_STRING_TOO_LONG' });
}

/** The length of the string `StringBytes::Encode` makes of `length` bytes. */
function encodedLength(length: number, encoding: number): number {
  switch (encoding) {
    case UCS2: return Math.floor(length / 2);
    case HEX: return length * 2;
    case BASE64: return Math.ceil(length / 3) * 4;
    case BASE64URL: return Math.ceil((length * 4) / 3);
    default: return length;
  }
}

/** `MakeString` (string_decoder.cc:27-54). */
function makeString(bytes: Uint8Array, encoding: number): string {
  if (encodedLength(bytes.length, encoding) > kStringMaxLength) throw stringTooLong();
  switch (encoding) {
    case UTF8: return utf8Slice(bytes, 0, bytes.length);
    case UCS2: return ucs2Slice(bytes, 0, bytes.length);
    case BASE64: return base64Slice(bytes, 0, bytes.length);
    case BASE64URL: return base64urlSlice(bytes, 0, bytes.length);
    case HEX: return hexSlice(bytes, 0, bytes.length);
    case ASCII: return asciiSlice(bytes, 0, bytes.length);
    case LATIN1: return latin1Slice(bytes, 0, bytes.length);
    default: throw new Error(`string_decoder: unknown encoding ${encoding}`);
  }
}

/** `ArrayBufferViewContents<char>`: a view's bytes, whatever its element type. */
function contentsOf(view: ArrayBufferView): Uint8Array {
  return view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** `StringDecoder::DecodeData` (string_decoder.cc:59-226). */
function decode(state: Uint8Array, input: ArrayBufferView): string {
  const encoding = state[kEncodingField] as number;
  let data = contentsOf(input);
  let nread = data.length;
  const held = (): Uint8Array => state.subarray(kIncompleteCharactersStart, kIncompleteCharactersStart + (state[kBufferedBytes] as number));
  const hold = (from: Uint8Array): void => {
    state.set(from, kIncompleteCharactersStart + (state[kBufferedBytes] as number));
  };

  if (encoding !== UTF8 && encoding !== UCS2 && encoding !== BASE64 && encoding !== BASE64URL) {
    if (encoding !== ASCII && encoding !== HEX && encoding !== LATIN1) throw new Error(`string_decoder: unknown encoding ${encoding}`);
    return makeString(data, encoding);
  }

  let prepend: string | undefined;
  let body: string;

  // Bytes that finish a character from the previous chunk go to the incomplete character buffer, and the finished
  // character is a small string prepended to the body.
  if ((state[kMissingBytes] as number) > 0) {
    if ((state[kMissingBytes] as number) + (state[kBufferedBytes] as number) > kIncompleteCharactersEnd) {
      throw new Error('string_decoder: more bytes missing than a character holds');
    }
    if (encoding === UTF8) {
      // An incomplete character at a chunk boundary is finished with what follows as V8's decoder would see it: a
      // byte that should continue it and does not starts a new character, and the bytes before it are its remainder.
      for (let i = 0; i < nread && i < (state[kMissingBytes] as number); i += 1) {
        if (((data[i] as number) & 0xc0) !== 0x80) {
          state[kMissingBytes] = 0;
          hold(data.subarray(0, i));
          state[kBufferedBytes] = (state[kBufferedBytes] as number) + i;
          data = data.subarray(i);
          nread -= i;
          break;
        }
      }
    }

    const found = Math.min(nread, state[kMissingBytes] as number);
    hold(data.subarray(0, found));
    data = data.subarray(found);
    nread -= found;
    state[kMissingBytes] = (state[kMissingBytes] as number) - found;
    state[kBufferedBytes] = (state[kBufferedBytes] as number) + found;

    if (state[kMissingBytes] === 0) {
      prepend = makeString(held(), encoding);
      state[kBufferedBytes] = 0;
    }
  }

  if (nread === 0) {
    // Finishing the previous chunk's character took all of this one.
    body = prepend ?? '';
    prepend = undefined;
  } else {
    // A character this chunk may cut off, to be finished by the next.
    if (encoding === UTF8 && ((data[nread - 1] as number) & 0x80)) {
      for (let i = nread - 1; ; i -= 1) {
        state[kBufferedBytes] = (state[kBufferedBytes] as number) + 1;
        if (((data[i] as number) & 0xc0) === 0x80) {
          // A trailing byte. Four of them, or no lead byte in the chunk, is invalid UTF-8, left to the decoder.
          if ((state[kBufferedBytes] as number) >= 4 || i === 0) {
            state[kBufferedBytes] = 0;
            break;
          }
        } else {
          // The lead byte: its upper bits say how long the character should be.
          const lead = data[i] as number;
          if ((lead & 0xe0) === 0xc0) state[kMissingBytes] = 2;
          else if ((lead & 0xf0) === 0xe0) state[kMissingBytes] = 3;
          else if ((lead & 0xf8) === 0xf0) state[kMissingBytes] = 4;
          else {
            // A lead byte for a character outside the representable range.
            state[kBufferedBytes] = 0;
            break;
          }
          if ((state[kBufferedBytes] as number) >= (state[kMissingBytes] as number)) {
            // As many trailing bytes as the lead names (complete) or more (invalid): nothing is cut off.
            state[kMissingBytes] = 0;
            state[kBufferedBytes] = 0;
          }
          state[kMissingBytes] = (state[kMissingBytes] as number) - (state[kBufferedBytes] as number);
          break;
        }
      }
    } else if (encoding === UCS2) {
      if ((nread % 2) === 1) {
        // Half a code unit.
        state[kBufferedBytes] = 1;
        state[kMissingBytes] = 1;
      } else if (((data[nread - 1] as number) & 0xfc) === 0xd8) {
        // Half a surrogate pair.
        state[kBufferedBytes] = 2;
        state[kMissingBytes] = 2;
      }
    } else if (encoding === BASE64 || encoding === BASE64URL) {
      state[kBufferedBytes] = nread % 3;
      if ((state[kBufferedBytes] as number) > 0) state[kMissingBytes] = 3 - (state[kBufferedBytes] as number);
    }

    const buffered = state[kBufferedBytes] as number;
    if (buffered > 0) {
      nread -= buffered;
      state.set(data.subarray(nread, nread + buffered), kIncompleteCharactersStart);
    }
    body = nread > 0 ? makeString(data.subarray(0, nread), encoding) : '';
  }

  return prepend === undefined ? body : prepend + body;
}

/** `StringDecoder::FlushData` (string_decoder.cc:228-257). */
function flush(state: Uint8Array): string {
  const encoding = state[kEncodingField] as number;
  if (encoding === UCS2 && (state[kBufferedBytes] as number) % 2 === 1) {
    // A single trailing byte is ignored, as the JS decoder ignores it.
    state[kMissingBytes] = (state[kMissingBytes] as number) - 1;
    state[kBufferedBytes] = (state[kBufferedBytes] as number) - 1;
  }
  const buffered = state[kBufferedBytes] as number;
  if (buffered === 0) return '';
  const text = makeString(state.subarray(kIncompleteCharactersStart, kIncompleteCharactersStart + buffered), encoding);
  state[kMissingBytes] = 0;
  state[kBufferedBytes] = 0;
  return text;
}

/** `encodings`, indexed by `enum encoding` (src/node.h) as `InitializeStringDecoder` fills it. */
const encodings: string[] = [];
encodings[ASCII] = 'ascii';
encodings[UTF8] = 'utf8';
encodings[BASE64] = 'base64';
encodings[BASE64URL] = 'base64url';
encodings[UCS2] = 'utf16le';
encodings[HEX] = 'hex';
encodings[BUFFER] = 'buffer';
encodings[LATIN1] = 'latin1';

/** `InitializeStringDecoder` (string_decoder.cc:288-330). */
export const stringDecoderBinding = {
  kIncompleteCharactersStart,
  kIncompleteCharactersEnd,
  kMissingBytes,
  kBufferedBytes,
  kEncodingField,
  kNumFields,
  encodings,
  kSize,
  decode,
  flush,
};
