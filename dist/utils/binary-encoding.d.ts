/**
 * Shared binary encoding utilities.
 * Replaces O(n²) string concatenation patterns used throughout the codebase.
 */
/** Convert Uint8Array to base64 string */
export declare function uint8ToBase64(bytes: Uint8Array): string;
/** Convert base64 string to Uint8Array */
export declare function base64ToUint8(base64: string): Uint8Array;
/** Convert Uint8Array to hex string */
export declare function uint8ToHex(bytes: Uint8Array): string;
/** Convert Uint8Array to binary (latin1) string */
export declare function uint8ToBinaryString(bytes: Uint8Array): string;
//# sourceMappingURL=binary-encoding.d.ts.map