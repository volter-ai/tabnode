// THE PROCESS'S START AND END (Tabnode ADR-0018 items 3 and 8): Node v24.21.0's src/node.cc PlatformInit (531-659),
// its stdio and signal parts, ResetStdio (661-724), SignalExit (188-191), RegisterSignalHandler (453-482),
// ResetSignalHandlers (494-521) and TearDownOncePerProcess (1354-1359), its stdio and signal part. Before anything
// is written, each of fds 0 to 2 that is not open is /dev/null opened there; the dispositions a parent left are put
// back (SIGPIPE and SIGXFSZ ignored, an inherited SIG_IGN the default); each descriptor's flags, and a terminal's
// termios, are recorded; and SIGINT and SIGTERM are SignalExit's, which resets the standard streams and raises the
// signal again with its default action, so a death by either signal leaves the terminal as it found it. At exit
// (atexit, as PlatformInit registers it) libuv's terminal mode is reset, and each descriptor that is still the file
// it was gets its O_NONBLOCK back (libuv's uv_tty_init and uv_pipe_open made it non-blocking, on a description other
// processes may share) and a terminal its termios. A listener of the program's for SIGINT or SIGTERM is libuv's
// uv_signal_t (signal_wrap.c), whose uv_signal_start takes the disposition from SignalExit and whose last
// uv_signal_stop leaves it SIG_DFL, as in Node.
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <termios.h>
#include <unistd.h>
#include <uv.h>
#include "wrap.h"

static struct {
  int flags;
  int isatty;
  struct stat stat;
  struct termios termios;
} stdio[1 + STDERR_FILENO];

static void reset_stdio(void) {
  uv_tty_reset_mode();
  for (int fd = 0; fd <= STDERR_FILENO; fd++) {
    struct stat now;
    if (fstat(fd, &now) == -1) continue;
    if (stdio[fd].stat.st_dev != now.st_dev || stdio[fd].stat.st_ino != now.st_ino) continue;
    int flags;
    do flags = fcntl(fd, F_GETFL);
    while (flags == -1 && errno == EINTR);
    if (flags == -1) abort();
    if (O_NONBLOCK & (flags ^ stdio[fd].flags)) {
      flags &= ~O_NONBLOCK;
      flags |= stdio[fd].flags & O_NONBLOCK;
      int err;
      do err = fcntl(fd, F_SETFL, flags);
      while (err == -1 && errno == EINTR);
      if (err == -1) abort();
    }
    if (stdio[fd].isatty) {
      // A background job that does not own its terminal would be stopped by SIGTTOU.
      sigset_t blocked;
      sigemptyset(&blocked);
      sigaddset(&blocked, SIGTTOU);
      pthread_sigmask(SIG_BLOCK, &blocked, NULL);
      int err;
      do err = tcsetattr(fd, TCSANOW, &stdio[fd].termios);
      while (err == -1 && errno == EINTR);
      pthread_sigmask(SIG_UNBLOCK, &blocked, NULL);
    }
  }
}

// SignalExit (node.cc:188-191): ResetStdio, then the signal again, which SA_RESETHAND has made the default action's.
// Node gives it as an sa_sigaction with no SA_SIGINFO, so Linux calls it with the signal alone; a WebAssembly table
// call is checked against the function's type, so here it is that one-argument handler.
static void signal_exit(int signo) {
  reset_stdio();
  raise(signo);
}

// RegisterSignalHandler (node.cc:453-482), with no V8 trap handler to stash it for.
static void register_signal_handler(int signal, void (*handler)(int), int reset_handler) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = handler;
  sa.sa_flags = reset_handler ? SA_RESETHAND : 0;
  sigfillset(&sa.sa_mask);
  if (sigaction(signal, &sa, NULL) != 0) abort();
}

// ResetSignalHandlers (node.cc:494-521): of each signal below kMaxSignal (32, src/node_internals.h:401) but SIGKILL
// and SIGSTOP, SIGPIPE and SIGXFSZ are ignored, and one inherited ignored (an exec keeps SIG_IGN) is the default
// again; a handler already there (an embedder's, or an LD_PRELOAD-ed library's) is left as it is.
static void reset_signal_handlers(void) {
  struct sigaction act;
  memset(&act, 0, sizeof act);
  for (int nr = 1; nr < 32; nr += 1) {
    if (nr == SIGKILL || nr == SIGSTOP) continue;
    act.sa_handler = (nr == SIGPIPE || nr == SIGXFSZ) ? SIG_IGN : SIG_DFL;
    if (act.sa_handler == SIG_DFL) {
      struct sigaction old;
      if (sigaction(nr, NULL, &old) != 0) abort();
      if ((old.sa_flags & SA_SIGINFO) || old.sa_handler != SIG_IGN) continue;
    }
    if (sigaction(nr, &act, NULL) != 0) abort();
  }
}

void tabnode_platform_init(void) {
  atexit(reset_stdio);
  for (int fd = 0; fd <= STDERR_FILENO; fd++) {
    if (fstat(fd, &stdio[fd].stat) == 0) continue;
    if (errno != EBADF) abort();
    int null_fd;
    do null_fd = open("/dev/null", O_RDWR);
    while (null_fd < 0 && errno == EINTR);
    if (null_fd != fd) {
      int err;
      do err = dup2(null_fd, fd);
      while (err < 0 && errno == EINTR);
      if (err < 0) abort();
    }
    if (fstat(fd, &stdio[fd].stat) < 0) abort();
  }
  reset_signal_handlers();
  // Recorded before the handlers below, which read it.
  for (int fd = 0; fd <= STDERR_FILENO; fd++) {
    do stdio[fd].flags = fcntl(fd, F_GETFL);
    while (stdio[fd].flags == -1 && errno == EINTR);
    if (stdio[fd].flags == -1) abort();
    if (uv_guess_handle(fd) != UV_TTY) continue;
    stdio[fd].isatty = 1;
    int err;
    do err = tcgetattr(fd, &stdio[fd].termios);
    while (err == -1 && errno == EINTR);
    if (err) abort();
  }
  register_signal_handler(SIGINT, signal_exit, 1);
  register_signal_handler(SIGTERM, signal_exit, 1);
}

// TearDownOncePerProcess's stdio and signal part (node.cc:1354-1359), as node::Start's scope leaves it.
void tabnode_platform_teardown(void) {
  reset_stdio();
  reset_signal_handlers();
}

// process.reallyExit (src/node_process_methods.cc ReallyExit, Environment::Exit): exit(3), so ResetStdio runs.
TABNODE_EXPORT(tabnode_exit) void tabnode_exit(int status) { exit(status); }
