#define _GNU_SOURCE
#include <sys/stat.h>

#ifdef __GLIBC__
#if defined(__x86_64__)
#define BASE_VERSION "GLIBC_2.2.5"
#define AT_VERSION "GLIBC_2.4"
#define STAT_VERSION 1
#elif defined(__aarch64__)
#define BASE_VERSION "GLIBC_2.17"
#define AT_VERSION BASE_VERSION
#define STAT_VERSION 0
#else
#error Unsupported provider helper architecture
#endif

/* Keep the host libc's exec semantics without importing newer builder ABI entry points. */
typedef int (*main_function)(int, char **, char **);
extern int compatible_start(main_function, int, char **, main_function,
                            void (*)(void), void (*)(void), void *);
__asm__(".symver compatible_start,__libc_start_main@" BASE_VERSION);
int __wrap___libc_start_main(main_function main, int argc, char **argv, main_function init,
                            void (*fini)(void), void (*rtld_fini)(void), void *stack) {
  return compatible_start(main, argc, argv, init, fini, rtld_fini, stack);
}

/* These versioned interfaces use the same 64-bit stat layout on both supported targets. */
extern int __fxstat(int, int, struct stat *);
extern int __lxstat(int, const char *, struct stat *);
extern int __fxstatat(int, int, const char *, struct stat *, int);
__asm__(".symver __fxstat,__fxstat@" BASE_VERSION);
__asm__(".symver __lxstat,__lxstat@" BASE_VERSION);
__asm__(".symver __fxstatat,__fxstatat@" AT_VERSION);
int __wrap_fstat(int fd, struct stat *out) { return __fxstat(STAT_VERSION, fd, out); }
int __wrap_lstat(const char *path, struct stat *out) { return __lxstat(STAT_VERSION, path, out); }
int __wrap_fstatat(int fd, const char *path, struct stat *out, int flags) {
  return __fxstatat(STAT_VERSION, fd, path, out, flags);
}

/* New GNU headers redirect these names to C23 parsing even when the target host predates it. */
extern long compatible_strtol(const char *, char **, int);
extern long long compatible_strtoll(const char *, char **, int);
__asm__(".symver compatible_strtol,strtol@" BASE_VERSION);
__asm__(".symver compatible_strtoll,strtoll@" BASE_VERSION);
long __wrap___isoc23_strtol(const char *text, char **end, int base) {
  return compatible_strtol(text, end, base);
}
long long __wrap___isoc23_strtoll(const char *text, char **end, int base) {
  return compatible_strtoll(text, end, base);
}
#endif
