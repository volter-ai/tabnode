/**
 * Node.js domain module shim
 * The domain module is deprecated but some packages still use it
 */
import { EventEmitter } from '../node-lib/events-module';
export declare class Domain extends EventEmitter {
    members: unknown[];
    add(emitter: EventEmitter): void;
    remove(emitter: EventEmitter): void;
    bind<T extends (...args: unknown[]) => unknown>(callback: T): T;
    intercept<T extends (...args: unknown[]) => unknown>(callback: T): T;
    run<T>(fn: () => T): T;
    dispose(): void;
    enter(): void;
    exit(): void;
}
export declare function create(): Domain;
export declare let active: Domain | null;
declare const _default: {
    Domain: typeof Domain;
    create: typeof create;
    active: null;
};
export default _default;
//# sourceMappingURL=domain.d.ts.map