/**
 * Node's `createBlobFromFilePath(path, { type })`: the bytes of that path
 * as a realm `Blob`. `fs.openAsBlob` is a promise of this value.
 */
export declare function createBlobFromFilePath(path: string, options?: {
    type?: string;
}): Blob;
declare const _default: {
    createBlobFromFilePath: typeof createBlobFromFilePath;
};
export default _default;
//# sourceMappingURL=blob.d.ts.map