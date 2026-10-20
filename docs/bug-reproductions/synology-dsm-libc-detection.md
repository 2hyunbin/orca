# Synology DSM library detection over SSH

Reproduced on 2026-10-20 using the official DS920+ DSM 7.4.1-90080
firmware. Build 90080, Gemini Lake x86-64 and Linux 4.4.302 match the
user's reported `uname -a`; their complete DSM installation was not available.

## Finding

The firmware has glibc 2.36, but neither `ldd` nor `getconf`. Orca's
first probe prints `/bin/sh: ldd: command not found`; its fallback returns
empty stdout. Production `resolveOrcadDeploymentTargetFacts` consequently
throws `UnidentifiedHostLibcError`, producing the reported unsupported-host
message before any Node runtime is started.

The firmware's loader gives direct evidence:

```text
/lib/ld-linux-x86-64.so.2 --version
ld.so (GNU libc) stable release version 2.36.
```

The fix tries the GNU loader only after the existing probes cannot identify
the library, and parses its release banner. Unknown libraries still fail
closed; SSH errors propagate. Normal Linux, musl and non-Linux selection
retain their existing probe order.

## Live evidence

A headless Lima Debian 12 ARM64 VM ran the extracted x86-64 DSM filesystem
in a chroot through `qemu-user-static`. `/dev` and `/proc` were mounted into
the chroot. The baseline production probe reproduced the failure. With the
fix it returned:

```json
{ "target": "linux-x64-glibc", "glibc": { "major": 2, "minor": 36 } }
```

The pinned runtime selector chose `linux-x64-glibc`. Orca's actual
`SshConnection` and `execCommand` also passed the probe and launched its
unmodified pinned Node through a loopback SSH endpoint whose commands run
inside that DSM chroot:

```json
{ "version": "v24.21.0", "arch": "x64", "glibc": "2.36" }
```

The endpoint used Debian's SSH server. DSM's own SSH server accepted the
test key but refused command sessions in the incomplete appliance
environment, so it was stopped. This verifies Orca's SSH command transport,
DSM library detection and Node startup, not a complete managed-server
deployment or Synology's login services. The VM kernel was
`6.1.0-53-cloud-arm64`; the NAS's 4.4.302 kernel was not booted.

## Reproduction inputs

- [Official DS920+ firmware](https://global.synologydownload.com/download/DSM/release/7.4.1/90080/DSM_DS920%2B_90080.pat)
  SHA-256: `0fca7121ba86486ff8156ae531931be0104c1125cdf5bd416bec7e64bc45e787`.
- Decrypted `hda1.tgz` is actually XZ-compressed. SHA-256:
  `0b6f421eec91d9862456bd94bd2e3df16a8702b38332126353ca3a7149b6e8e0`.
- Extraction used [patology](https://github.com/sud0woodo/patology), with
  `msgpack`, `pysodium` and `dissect.cstruct`. The downloaded extractor's
  SHA-256 was `add398aa4058dd4b6e1dbe36ed89a5b259074cb702d77b460023e98ce143a3a6`.
- Node archive: `node-v24.21.0-linux-x64.tar.gz` from nodejs.org. SHA-256
  `6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff`,
  matching Orca's runtime pin.

The local VM is named `orca-synology-debug`, with the root filesystem at
`/var/tmp/orca-dsm-root` inside it. Ignored local files under
`tmp/synology-debug/` retain the downloads, extraction tool, SSH command
runner, and before/after logs. Resume and run the transport check from the
repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 limactl start orca-synology-debug
ORCA_BACKGROUND_LAUNCH=1 limactl shell orca-synology-debug -- sudo sh "$PWD/tmp/synology-debug/start-dsm-ssh.sh"
ORCA_BACKGROUND_LAUNCH=1 pnpm exec tsx --conditions=orca-source tmp/synology-debug/probe-ssh.ts
```

Regression coverage lives in `src/main/ssh/orcad-deployment-target.test.ts`.
