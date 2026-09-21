/**
 * v8 shim - V8 engine internals are not available in browser
 * Provides stubs for common usage patterns
 */
export declare function getHeapStatistics(): {
    total_heap_size: number;
    total_heap_size_executable: number;
    total_physical_size: number;
    total_available_size: number;
    used_heap_size: number;
    heap_size_limit: number;
    malloced_memory: number;
    peak_malloced_memory: number;
    does_zap_garbage: number;
    number_of_native_contexts: number;
    number_of_detached_contexts: number;
};
export declare function getHeapSpaceStatistics(): never[];
export declare function getHeapCodeStatistics(): {
    code_and_metadata_size: number;
    bytecode_and_metadata_size: number;
    external_script_source_size: number;
};
export declare function getHeapSnapshot(): null;
export declare function writeHeapSnapshot(): string;
export declare function setFlagsFromString(_flags: string): void;
export declare function takeCoverage(): void;
export declare function stopCoverage(): void;
export declare function serialize(value: unknown): Buffer;
export declare function deserialize(buffer: Buffer): unknown;
export declare class Serializer {
    writeHeader(): void;
    writeValue(_value: unknown): void;
    releaseBuffer(): Buffer;
}
export declare class Deserializer {
    constructor(_buffer: Buffer);
    readHeader(): boolean;
    readValue(): unknown;
}
export declare class DefaultSerializer extends Serializer {
}
export declare class DefaultDeserializer extends Deserializer {
}
export declare function promiseHooks(): {
    onInit: () => void;
    onSettled: () => void;
    onBefore: () => void;
    onAfter: () => void;
    createHook: () => {
        enable: () => void;
        disable: () => void;
    };
};
declare const _default: {
    getHeapStatistics: typeof getHeapStatistics;
    getHeapSpaceStatistics: typeof getHeapSpaceStatistics;
    getHeapCodeStatistics: typeof getHeapCodeStatistics;
    getHeapSnapshot: typeof getHeapSnapshot;
    writeHeapSnapshot: typeof writeHeapSnapshot;
    setFlagsFromString: typeof setFlagsFromString;
    takeCoverage: typeof takeCoverage;
    stopCoverage: typeof stopCoverage;
    serialize: typeof serialize;
    deserialize: typeof deserialize;
    Serializer: typeof Serializer;
    Deserializer: typeof Deserializer;
    DefaultSerializer: typeof DefaultSerializer;
    DefaultDeserializer: typeof DefaultDeserializer;
    promiseHooks: typeof promiseHooks;
};
export default _default;
//# sourceMappingURL=v8.d.ts.map