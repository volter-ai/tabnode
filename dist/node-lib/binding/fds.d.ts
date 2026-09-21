/**
 * The file descriptors a handle can be opened on.
 *
 * libuv answers `uv_guess_handle(fd)` from the kernel. The engine has no
 * kernel and no descriptors of its own beyond the three a process is started
 * with and the ones a spawn hands a child, so the table is what the engine
 * itself opened: a `Pipe` or `TCP` registered here by the run that made it,
 * and the three standard ones, which are pipes because the engine's stdio is
 * a stream the host reads, never a terminal it owns.
 *
 * `net.js` reads it through `internal/util`'s `guessHandleType` when a program
 * builds a socket on a descriptor (`new net.Socket({ fd })`) and when a server
 * listens on one.
 */
import type { ProcessToken } from '../../process-tokens';
/** What libuv answers for a descriptor. */
export type HandleType = 'TCP' | 'TTY' | 'UDP' | 'FILE' | 'PIPE' | 'UNKNOWN';
/** Record a descriptor a run is started with, under that run's name. */
export declare function registerRunFd(token: ProcessToken, fd: number, type: HandleType, handle: unknown): void;
/** A run that has ended was started with nothing. */
export declare function releaseRunFds(token: ProcessToken): void;
/** Record a handle under a descriptor of the engine's own, and answer the number. */
export declare function registerFd(type: HandleType, handle: unknown): number;
/** The handle a descriptor names, for `Pipe.open(fd)` and `TCP.open(fd)`. */
export declare function handleForFd(fd: number): unknown;
/** Give a descriptor back; a handle that closes stops answering for one. */
export declare function releaseFd(fd: number): void;
/** libuv's `uv_guess_handle`. */
export declare function guessHandleTypeOfFd(fd: number): HandleType;
//# sourceMappingURL=fds.d.ts.map