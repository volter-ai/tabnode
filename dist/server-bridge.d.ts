/**
 * Server Bridge
 * Connects Service Worker requests to virtual HTTP servers
 */
import { type ResponseData } from './node-lib/http-bridge';
import { EventEmitter } from './node-lib/events-module';
/**
 * Interface for virtual servers that can be registered with the bridge
 */
export interface IVirtualServer {
    listening: boolean;
    /** What `net.Server.address()` answers: an address and a port, or the PATH of a unix-domain socket. */
    address(): {
        port: number;
        address: string;
        family: string;
    } | string | null;
    handleRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer | string): Promise<ResponseData>;
}
export interface VirtualServer {
    /**
     * A server the host registered and answers itself, or null for a guest's
     * own: a guest's server is a port this engine is listening on, and it is
     * reached by connecting to it like any other client.
     */
    server: IVirtualServer | null;
    port: number;
    hostname: string;
}
export interface BridgeOptions {
    baseUrl?: string;
    onServerReady?: (port: number, url: string) => void;
}
export interface InitServiceWorkerOptions {
    /**
     * The URL path to the service worker file
     * @default '/__sw__.js'
     */
    swUrl?: string;
    /**
     * The page's own documents that are frames of it (a sandbox, a worker
     * host), by path, so the worker does not take one for the preview's.
     */
    ownDocuments?: string[];
}
export declare class ServerBridge extends EventEmitter {
    static DEBUG: boolean;
    servers: Map<number, VirtualServer>;
    private baseUrl;
    private options;
    private messageChannel;
    /** The upgrade channel this bridge opened, held so it can be given back. */
    private upgradeChannel;
    private serviceWorkerReady;
    private keepaliveInterval;
    constructor(options?: BridgeOptions);
    /**
     * Give back everything this bridge opened: the upgrade channel and the
     * service worker keepalive. A host that is done with a container calls it
     * and has its process back; calling it twice is nothing.
     */
    /**
     * Every port a guest starts listening on becomes a server this bridge can
     * answer for, and every port it stops listening on stops being one. The
     * news comes from the net binding, because that is where a port is taken;
     * the engine's `http` is Node's own file and knows nothing of a page.
     */
    private watchGuestPorts;
    close(): void;
    /**
     * Register a server on a port
     */
    registerServer(server: IVirtualServer | null, port: number, hostname?: string): void;
    /**
     * Unregister a server
     */
    unregisterServer(port: number): void;
    /** The server the service worker answers at the origin's root, the preview's; null for none. */
    private primaryPort;
    /**
     * Names the server the service worker serves at the origin's root, as an
     * app is served at its own origin's root: its documents read their routes
     * from `location.pathname`, which under /__virtual__/<port>/ is not the
     * path they expect. Told to the worker now and again whenever the worker
     * is (re)initialized, since a worker that restarted remembers nothing.
     */
    setPrimaryPort(port: number | null): void;
    /** Every registration the worker should hold, sent again to a worker that was (re)initialized. */
    private announceServers;
    private ownDocuments;
    /**
     * Get server URL for a port
     */
    getServerUrl(port: number): string;
    /**
     * Get all registered server ports
     */
    getServerPorts(): number[];
    /**
     * Handle an incoming request from Service Worker
     */
    handleRequest(port: number, method: string, url: string, headers: Record<string, string>, body?: ArrayBuffer): Promise<ResponseData>;
    /**
     * Initialize Service Worker communication
     * @param options - Configuration options for the service worker
     * @param options.swUrl - Custom URL path to the service worker file (default: '/__sw__.js')
     */
    initServiceWorker(options?: InitServiceWorkerOptions): Promise<void>;
    /**
     * Handle messages from Service Worker
     */
    private handleServiceWorkerMessage;
    /**
     * Handle a streaming request - sends chunks as they arrive
     */
    /**
     * A page-side request streamed to the caller as it arrives, the door a host
     * reads a guest's server through when it wants chunks rather than a body:
     * a guest's own server is reached over the loopback as any client reaches
     * it; a server the host registered answers through its own streaming
     * method where it has one, else its buffered answer is delivered whole.
     */
    handleStreamingRequest(port: number, method: string, url: string, headers: Record<string, string>, body: ArrayBuffer | undefined, callbacks: {
        start(statusCode: number, statusMessage: string, headers: Record<string, string>): void;
        chunk(chunk: Uint8Array): void;
        end(): void;
    }): Promise<boolean>;
    private streamToServiceWorker;
    /**
     * Send message to Service Worker
     */
    private notifyServiceWorker;
    /**
     * Create a mock request handler for testing without Service Worker
     */
    createFetchHandler(): (request: Request) => Promise<Response>;
}
/**
 * Get or create the global server bridge
 */
export declare function getServerBridge(options?: BridgeOptions): ServerBridge;
/**
 * Reset the global bridge (for testing)
 */
export declare function resetServerBridge(): void;
export default ServerBridge;
//# sourceMappingURL=server-bridge.d.ts.map