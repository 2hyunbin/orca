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

SSH and both WSL runtime setup paths now share the same probe. It tries
`ldd`, `getconf`, GNU loaders, executable GNU libraries, then musl loaders.
Each command uses the C locale, and only recognizable library banners count
as evidence. Unrecognized output falls through even when a tool exits
successfully. Unknown libraries still fail closed; transport errors propagate.

The musl fallback executes the loader instead of inferring the host library
from a filename. Checking GNU libraries first also prevents an installed
musl toolchain from overriding a GNU host when the normal tools are missing.

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

## Related failures checked

The same VM also ran official DS920+ DSM 7.2.2-72806 and 7.1.1-42962
filesystems. Both omit `ldd` and `getconf`. DSM 7.2.2 reports glibc 2.36
through its loader. DSM 7.1.1 has glibc 2.26, whose loader treats
`--version` as a program name and prints an error:

```text
--version: error while loading shared libraries: --version: cannot open shared object file: No such file or directory
```

Executing `/lib/libc.so.6` instead prints:

```text
GNU C Library (GNU libc) stable release version 2.26, by Roland McGrath et al.
```

The shared production probe correctly identifies that version, and the SSH
runtime selector chooses the existing `linux-x64-glibc217` compatibility
runtime. That runtime was not launched in this additional root filesystem.
The WSL path retains its existing minimum-version rejection policy.

Alpine 3.22.2 ARM64 and the VM's Debian 12 ARM64 also passed. With
`PATH=/nonexistent`, Alpine was identified from its musl loader's stderr
banner despite its nonzero exit status, and Debian from its GNU loader.
These checks used real shells and libraries; WSL command dispatch and
reader preparation were checked through automated tests, not a Windows VM.

Regression tests also cover login banners before library output, unrelated
version numbers, error text mentioning glibc/musl, and connection loss
during a fallback.

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
- [Official DSM 7.1.1-42962 firmware](https://global.synologydownload.com/download/DSM/release/7.1.1/42962/DSM_DS920%2B_42962.pat)
  SHA-256: `90b1bd215b85eb366b3d3b6bef6bb6bef657dd0caba032dae556717b58e44c06`.
  Its decrypted `hda1.tgz` SHA-256:
  `2516a283561ad78d0bb42e0a065af96772b80e575d30338f8279006a1e2864af`.
- [Official DSM 7.2.2-72806 firmware](https://global.synologydownload.com/download/DSM/release/7.2.2/72806/DSM_DS920%2B_72806.pat)
  SHA-256: `c8dc7d0f327718f40820a7e6275a5257c6decd80c231b312540ca0a6b7120cfb`.
- [Alpine 3.22.2 ARM64 root filesystem](https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/alpine-minirootfs-3.22.2-aarch64.tar.gz).

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

Regression coverage lives in `src/main/node-runtime/linux-libc-probe.test.ts`,
`src/main/ssh/orcad-deployment-target.test.ts`,
`src/main/wsl/wsl-pinned-runtime.test.ts`, and
`src/main/ai-vault/opencode-wsl-runtime-preparation.test.ts`.
