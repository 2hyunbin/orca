#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

/* Session membership reserves the provider group number through leader exit. */
static long long now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts)) _exit(70);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static void failed(const char *stage) {
  int code = errno;
  dprintf(5, "ERROR %s %d\n", stage, code);
  _exit(127);
}
static int line(int fd, char *out, size_t cap, long long deadline) {
  size_t used = 0;
  while (used + 1 < cap) {
    long long remaining = deadline - now_ms();
    if (remaining <= 0) return -1;
    struct pollfd p = {fd, POLLIN, 0};
    int ready = poll(&p, 1, remaining > INT_MAX ? INT_MAX : (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) return -1;
    char c;
    ssize_t n = read(fd, &c, 1);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    if (c == '\n') { out[used] = 0; return 1; }
    out[used++] = c;
  }
  return -1;
}
static int scope(pid_t group) {
  return group > 1 && getsid(0) == group && getpgrp() != group;
}
static int group_state(pid_t group) {
  if (!scope(group)) return -1;
  if (!kill(-group, 0)) return 1;
  return errno == ESRCH ? 0 : -1;
}
static int group_signal(pid_t group, int sig) {
  if (!scope(group)) return -1;
  if (!kill(-group, sig)) return 1;
  return errno == ESRCH ? 0 : -1;
}
static int wait_group(pid_t group, long long deadline) {
  for (;;) {
    int state = group_state(group);
    if (state <= 0 || now_ms() >= deadline) return state;
    struct timespec pause = {0, 25000000};
    while (nanosleep(&pause, &pause) && errno == EINTR) {}
  }
}
static int crash(pid_t group, int phase, long long deadline) {
  int state;
  if (!deadline) deadline = now_ms() + (phase == 0 ? 1000 : phase == 1 ? 3000 : 1500);
  if (phase == 0) {
    state = wait_group(group, deadline);
    if (state <= 0) return state;
    phase = 1; deadline = now_ms() + 3000;
  }
  if (phase == 1) {
    state = group_signal(group, SIGTERM);
    if (state <= 0) return state;
    state = wait_group(group, deadline);
    if (state <= 0) return state;
    phase = 2; deadline = now_ms() + 1500;
  }
  if (phase == 2) {
    state = group_signal(group, SIGKILL);
    if (state <= 0) return state;
    return wait_group(group, deadline);
  }
  return -1;
}
static void provider_exec(char **args) {
  for (int sig = 1; sig < NSIG; sig++) {
    if (sig != SIGKILL && sig != SIGSTOP) signal(sig, SIG_DFL);
  }
  sigset_t mask;
  sigemptyset(&mask);
  sigprocmask(SIG_SETMASK, &mask, NULL);
#ifdef __APPLE__
  /* Match Darwin libuv's explicit PATH search, including no ENOEXEC fallback. */
  if (strchr(args[0], '/')) execve(args[0], args, environ);
  else {
    const char *path = getenv("PATH");
    if (!path) path = "/usr/bin:/bin:/usr/sbin:/sbin";
    int denied = 0;
    const char *part = path;
    for (;;) {
      const char *end = strchr(part, ':');
      size_t count = end ? (size_t)(end - part) : strlen(part);
      char target[PATH_MAX];
      int n = count ? snprintf(target, sizeof(target), "%.*s/%s", (int)count, part, args[0])
                    : snprintf(target, sizeof(target), "%s", args[0]);
      if (n < 0 || (size_t)n >= sizeof(target)) { errno = ENAMETOOLONG; break; }
      execve(target, args, environ);
      if (errno == EACCES) denied = 1;
      else if (errno != ENOENT && errno != ENOTDIR) break;
      if (!end) { errno = denied ? EACCES : ENOENT; break; }
      part = end + 1;
    }
  }
#else
  execvp(args[0], args);
#endif
  failed("exec");
}
static const char watcher[] =
  "trap '' HUP PIPE\n"
  "h=$1; nonce=$2; group=$3; phase=0; deadline=$4\n"
  "printf 'ARMED %s %s\\n' \"$nonce\" \"$$\" >&4\n"
  "while IFS=' ' read -r tag a b c <&4; do\n"
  "  test \"$a\" = \"$nonce\" || break\n"
  "  case $tag in\n"
  "    RETIRE|ABANDON) printf 'RETIRED %s\\n' \"$nonce\" >&4; exit 0;;\n"
  "    PHASE) phase=$b; deadline=$c; printf 'PHASE %s %s %s\\n' \"$nonce\" \"$phase\" \"$deadline\" >&4;;\n"
  "    PROBE|TERM|KILL) result=$(exec 4>&-; exec \"$h\" op \"$group\" \"$tag\"); printf 'RESULT %s %s\\n' \"$nonce\" \"$result\" >&4;;\n"
  "    *) break;;\n"
  "  esac\n"
  "done\n"
  "exec 4>&-\n"
  "exec \"$h\" crash \"$group\" \"$phase\" \"$deadline\"\n";
static int same_file(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int private_file(int fd, const char *path) {
  struct stat held, named;
  return !fstat(fd, &held) && !lstat(path, &named) && same_file(&held, &named)
    && S_ISREG(held.st_mode) && held.st_uid == geteuid() && held.st_nlink == 1
    && !(held.st_mode & 077);
}
static int retire_copy(const char *candidate, const char *tombstone) {
  int directory = open(candidate, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) return 3;
  struct stat original, named, held, file;
  int fd = openat(directory, "hold", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  int result = 3;
  if (fd >= 0 && !fstat(directory, &original) && original.st_uid == geteuid()
      && !(original.st_mode & 077) && !fstat(fd, &held) && S_ISREG(held.st_mode)
      && held.st_uid == geteuid() && !(held.st_mode & 077) && held.st_nlink == 1) {
    if (flock(fd, LOCK_EX | LOCK_NB)) result = errno == EWOULDBLOCK ? 2 : 3;
    else if (!lstat(candidate, &named) && same_file(&original, &named)
        && !fstatat(directory, "hold", &file, AT_SYMLINK_NOFOLLOW) && same_file(&held, &file)
        && lstat(tombstone, &named) && errno == ENOENT && !rename(candidate, tombstone)) {
      puts("RETIRED"); result = 0;
    }
  }
  if (fd >= 0) close(fd);
  close(directory);
  return result;
}
int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (!strcmp(argv[1], "collect") && argc == 4) return retire_copy(argv[2], argv[3]);
  if (!strcmp(argv[1], "pin") || !strcmp(argv[1], "probe-lock")) {
    if (argc != 3 || !private_file(6, argv[2])) return 3;
    int operation = !strcmp(argv[1], "pin") ? LOCK_SH : LOCK_EX;
    if (flock(6, operation | LOCK_NB)) return errno == EWOULDBLOCK ? 2 : 3;
    if (!private_file(6, argv[2])) return 3;
    puts("LOCKED"); return 0;
  }
  if (!strcmp(argv[1], "op") && argc == 4) {
    pid_t group = (pid_t)strtol(argv[2], NULL, 10);
    int result = !strcmp(argv[3], "PROBE") ? group_state(group)
      : group_signal(group, !strcmp(argv[3], "TERM") ? SIGTERM : SIGKILL);
    printf("%d %lld\n", result, now_ms()); return result < 0 ? 1 : 0;
  }
  if (!strcmp(argv[1], "crash") && argc == 5) {
    int result = crash((pid_t)strtol(argv[2], NULL, 10), atoi(argv[3]), strtoll(argv[4], NULL, 10));
    return result == 0 ? 0 : 1;
  }
  if (strcmp(argv[1], "gate") || argc < 4 || strlen(argv[2]) > 64) return 64;
  pid_t root = getpid();
  if (getpgrp() != root || getsid(0) != root) { errno = EPERM; failed("session"); }
  /* Ignore before orphaning the watcher's group, including the exec interval. */
  signal(SIGHUP, SIG_IGN); signal(SIGPIPE, SIG_IGN);
  long long arm_deadline = now_ms() + 5000;
  char root_text[32], deadline_text[32];
  snprintf(root_text, sizeof(root_text), "%d", root);
  snprintf(deadline_text, sizeof(deadline_text), "0");
  pid_t intermediate = fork();
  if (intermediate < 0) failed("fork");
  if (!intermediate) {
    close(3); close(5);
    pid_t child = fork();
    if (child < 0) _exit(71);
    if (child) _exit(0);
    if (setpgid(0, 0)) _exit(72);
    int null_fd = open("/dev/null", O_RDWR);
    if (null_fd < 0) _exit(73);
    for (int fd = 0; fd < 3; fd++) if (dup2(null_fd, fd) < 0) _exit(74);
    if (null_fd > 6) close(null_fd);
    execl("/bin/sh", "sh", "-c", watcher, "orca-watcher", argv[0], argv[2], root_text, deadline_text, (char *)NULL);
    _exit(75);
  }
  close(4);
  int status;
  while (waitpid(intermediate, &status, 0) < 0) if (errno != EINTR) failed("wait");
  if (!WIFEXITED(status) || WEXITSTATUS(status)) { errno = ECHILD; failed("birth"); }
  dprintf(3, "SETUP_COMPLETE %s %d\n", argv[2], root);
  char permission[96], expected[96];
  snprintf(expected, sizeof(expected), "EXEC %s", argv[2]);
  int accepted = line(3, permission, sizeof(permission), arm_deadline);
  if (accepted != 1 || strcmp(expected, permission)) _exit(76);
  close(3); close(6);
  if (fcntl(5, F_SETFD, FD_CLOEXEC)) failed("cloexec");
  provider_exec(argv + 3);
  return 127;
}
