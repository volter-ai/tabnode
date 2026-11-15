/**
 * A PROCESS'S STANDARD STREAMS ARE NODE'S (ADR-0018 item 3), where the realm's process is `node` on libuv's loop:
 * `process.stdout`, `process.stderr` and `process.stdin` made as Node v24.21.0's
 * `lib/internal/bootstrap/switches/is_main_thread.js` makes them (`defineStream`, `createWritableStdioStream`,
 * `getStdout`, `getStderr`, `getStdin`), each on first read, over the bindings' libuv handles: a terminal is
 * `tty.WriteStream` or `tty.ReadStream` (a uv_tty_t), a pipe or a socket `net.Socket` on the descriptor (a uv_pipe_t
 * or uv_tcp_t), a file `SyncWriteStream` or `fs.ReadStream`. What reaches fd 1 and 2 is then what libuv writes, in the
 * order the program wrote it.
 *
 * Node's file is its bootstrap's, and runs only where the bootstrap runs on the realm's own global (ADR-0018 §7); until
 * then its stream part is carried here line for line, against the engine's process and the library graph it loads.
 */
import { loadNodeLibFor } from './load';

type Stream = Record<string, any>;

/** `process.stdout`, `process.stderr` and `process.stdin` of `proc` become Node's, made on first read. */
export function installNodeStdio(proc: object): void {
  const process = proc as Stream;
  const require = (name: string): any => loadNodeLibFor(proc, name);
  const { guessHandleType } = require('internal/util') as { guessHandleType(fd: number): string };

  function createWritableStdioStream(fd: 1 | 2): Stream {
    let stream: Stream;
    // Note stream._type is used for test-module-load-list.js
    switch (guessHandleType(fd)) {
      case 'TTY': {
        const tty = require('tty');
        stream = new tty.WriteStream(fd);
        stream._type = 'tty';
        break;
      }
      case 'FILE': {
        const SyncWriteStream = require('internal/fs/sync_write_stream');
        stream = new SyncWriteStream(fd, { autoClose: false });
        stream._type = 'fs';
        break;
      }
      case 'PIPE':
      case 'TCP': {
        const net = require('net');
        // If fd is already being used for the IPC channel, libuv will return an error when trying to use it again.
        // In that case, create the socket using the existing handle instead of the fd.
        if (process.channel && process.channel.fd === fd) {
          const { kChannelHandle } = require('internal/child_process');
          stream = new net.Socket({ handle: process[kChannelHandle], readable: false, writable: true });
        } else {
          stream = new net.Socket({ fd, readable: false, writable: true });
        }
        stream._type = 'pipe';
        break;
      }
      default: {
        // A dummy black-hole output.
        const { Writable } = require('stream');
        stream = new Writable({ write(_buf: unknown, _enc: unknown, cb: () => void) { cb(); } });
      }
    }
    // For supporting legacy API we put the FD here.
    stream.fd = fd;
    stream._isStdio = true;
    return stream;
  }

  function dummyDestroy(this: Stream, err: unknown, cb: (err: unknown) => void): void {
    cb(err);
    this._undestroy();
    // The 'close' event is needed so that finished and pipeline work correctly.
    if (!this._writableState.emitClose) {
      process.nextTick(() => { this.emit('close'); });
    }
  }

  let stdin: Stream | undefined;
  let stdout: Stream | undefined;
  let stderr: Stream | undefined;

  function getStdout(): Stream {
    if (stdout) return stdout;
    stdout = createWritableStdioStream(1);
    stdout.destroySoon = stdout.destroy;
    // Override _destroy so that the fd is never actually closed.
    stdout._destroy = dummyDestroy;
    if (stdout.isTTY) process.on('SIGWINCH', () => stdout!._refreshSize());
    return stdout;
  }

  function getStderr(): Stream {
    if (stderr) return stderr;
    stderr = createWritableStdioStream(2);
    stderr.destroySoon = stderr.destroy;
    // Override _destroy so that the fd is never actually closed.
    stderr._destroy = dummyDestroy;
    if (stderr.isTTY) process.on('SIGWINCH', () => stderr!._refreshSize());
    return stderr;
  }

  function getStdin(): Stream {
    if (stdin) return stdin;
    const fd = 0;
    switch (guessHandleType(fd)) {
      case 'TTY': {
        const tty = require('tty');
        stdin = new tty.ReadStream(fd);
        break;
      }
      case 'FILE': {
        const fs = require('fs');
        stdin = new fs.ReadStream(null, { fd, autoClose: false });
        break;
      }
      case 'PIPE':
      case 'TCP': {
        const net = require('net');
        // It could be that process has been started with an IPC channel sitting on fd=0, in such case the pipe for
        // this fd is already present and creating a new one will lead to the assertion failure in libuv.
        if (process.channel && process.channel.fd === fd) {
          stdin = new net.Socket({ handle: process.channel, readable: true, writable: false, manualStart: true });
        } else {
          stdin = new net.Socket({ fd, readable: true, writable: false, manualStart: true });
        }
        // Make sure the stdin can't be `.end()`-ed
        stdin!._writableState.ended = true;
        break;
      }
      default: {
        // A dummy contentless input.
        const { Readable } = require('stream');
        stdin = new Readable({ read() {} });
        stdin!.push(null);
      }
    }
    const input = stdin!;
    // For supporting legacy API we put the FD here.
    input.fd = fd;
    // `stdin` starts out life in a paused state, but node doesn't know yet. Explicitly to readStop() it to put it in
    // the not-reading state.
    if (input._handle?.readStop) {
      input._handle.reading = false;
      input._readableState.reading = false;
      input._handle.readStop();
    }
    // If the user calls stdin.pause(), then we need to stop reading once the stream implementation does so (one
    // nextTick later), so that the process can close down.
    const onpause = (): void => {
      if (!input._handle) return;
      if (input._handle.reading && !input.readableFlowing) {
        input._readableState.reading = false;
        input._handle.reading = false;
        input._handle.readStop();
      }
    };
    input.on('pause', () => { process.nextTick(onpause); });
    return input;
  }

  const defineStream = (name: string, getter: () => Stream): void => {
    Object.defineProperty(process, name, { __proto__: null, configurable: true, enumerable: true, get: getter } as PropertyDescriptor);
  };
  defineStream('stdout', getStdout);
  defineStream('stdin', getStdin);
  defineStream('stderr', getStderr);
}
