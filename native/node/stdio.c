// THE STANDARD STREAMS' START AND END (Tabnode ADR-0018 item 3): Node v24.21.0's src/node.cc PlatformInit, its stdio
// part (543-614), and ResetStdio (661-724). Before anything is written, each of fds 0 to 2 that is not open is
// /dev/null opened there; each one's flags, and a terminal's termios, are recorded. At exit (atexit, as PlatformInit
// registers it) libuv's terminal mode is reset, and each descriptor that is still the file it was gets its O_NONBLOCK
// back (libuv's uv_tty_init and uv_pipe_open made it non-blocking, on a description other processes may share) and a
// terminal its termios. Node's SIGINT and SIGTERM handlers (SignalExit, which reset the same way) are not here.
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
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
}

// process.reallyExit (src/node_process_methods.cc ReallyExit, Environment::Exit): exit(3), so ResetStdio runs.
TABNODE_EXPORT(tabnode_exit) void tabnode_exit(int status) { exit(status); }
