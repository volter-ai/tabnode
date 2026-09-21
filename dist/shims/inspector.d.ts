/**
 * inspector shim - V8 inspector is not available in browser
 */
import { EventEmitter } from '../node-lib/events-module';
export declare class Session extends EventEmitter {
    connect(): void;
    connectToMainThread(): void;
    disconnect(): void;
    post(_method: string, _params?: object, _callback?: (err: Error | null, result?: object) => void): void;
}
export declare function open(_port?: number, _host?: string, _wait?: boolean): void;
export declare function close(): void;
export declare function url(): string | undefined;
export declare function waitForDebugger(): void;
export declare const console: Console;
declare const _default: {
    Session: typeof Session;
    open: typeof open;
    close: typeof close;
    url: typeof url;
    waitForDebugger: typeof waitForDebugger;
    console: Console;
};
export default _default;
//# sourceMappingURL=inspector.d.ts.map