import { posix } from 'node:path'
import { toWindowsWslPath } from '../../../shared/wsl-paths'
import { runWslProcess } from '../../wsl/wsl-runner'
import type { SkillDirectoryEntry, SkillFilesystemEntryKind } from '../skill-install-filesystem'
import type { SkillProviderRootOverrides } from '../skill-provider-destinations'
import { createWslSkillInstallFilesystem, toWslGuestPath } from '../skill-wsl-install-filesystem'
import type { BundledSkillFilesystem, BundledSkillPathObservation } from './filesystem'
import { bundledSkillBackupsRoot } from './swap'

const GUEST_COMMAND_TIMEOUT_MS = 30_000
const OBSERVE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

// Records keyed by argument index, NUL-delimited: L(ink) index ok target real, D(irectory) index
// then E name kind per entry and S base64 for a plain SKILL.md, X index (unlistable),
// F index kind mtime, M index (missing).
export const WSL_OBSERVE_SCRIPT = [
  'set -u',
  'index=0',
  'for path in "$@"; do',
  '  if [ -L "$path" ]; then',
  '    if target=$(readlink -- "$path"); then ok=1; else ok=0; target=; fi',
  `    real=; [ -e "$path" ] && real=$(readlink -f -- "$path" 2>/dev/null || printf '')`,
  `    printf 'L\\0%s\\0%s\\0%s\\0%s\\0' "$index" "$ok" "$target" "$real"`,
  '  elif [ -d "$path" ]; then',
  '    if [ -r "$path" ] && [ -x "$path" ]; then',
  `      printf 'D\\0%s\\0' "$index"`,
  '      for entry in "$path"/* "$path"/.*; do',
  '        name=${entry##*/}',
  '        case "$name" in "*"|".*"|"."|"..") continue ;; esac',
  '        if [ -L "$entry" ]; then kind=symlink',
  '        elif [ -d "$entry" ]; then kind=directory',
  '        elif [ -f "$entry" ]; then kind=file',
  '        elif [ -e "$entry" ]; then kind=other',
  '        else continue; fi',
  `        printf 'E\\0%s\\0%s\\0' "$name" "$kind"`,
  '      done',
  '      skill="$path/SKILL.md"',
  '      if [ -f "$skill" ] && [ ! -L "$skill" ]; then',
  `        if bytes=$(base64 < "$skill" 2>/dev/null); then printf 'S\\0%s\\0' "$bytes"; fi`,
  '      fi',
  '    else',
  `      printf 'X\\0%s\\0' "$index"`,
  '    fi',
  '  elif [ -e "$path" ]; then',
  '    kind=other; [ -f "$path" ] && kind=file',
  `    printf 'F\\0%s\\0%s\\0%s\\0' "$index" "$kind" "$(stat -c %Y -- "$path" 2>/dev/null || printf '')"`,
  '  else',
  `    printf 'M\\0%s\\0' "$index"`,
  '  fi',
  '  index=$((index + 1))',
  'done'
].join('\n')

const REALPATH_SCRIPT = ['set -u', '[ -e "$1" ] || exit 0', 'readlink -f -- "$1"'].join('\n')

const CAN_WRITE_SCRIPT = [
  'set -u',
  'dir=$1',
  'while [ ! -e "$dir" ] && [ "$dir" != / ]; do dir=$(dirname -- "$dir"); done',
  '[ -d "$dir" ] && [ -w "$dir" ] && printf yes',
  'true'
].join('\n')

// Why base64: argv carries only ASCII, so `SKILL.md` bytes reach the guest unchanged.
const WRITE_FOLDER_SCRIPT = [
  'set -eu',
  'dir=$1; shift',
  'mkdir -p -- "$(dirname -- "$dir")"',
  'mkdir -m 755 -- "$dir"',
  'while [ "$#" -gt 1 ]; do',
  '  file="$dir/$1"',
  '  mkdir -p -m 755 -- "$(dirname -- "$file")"',
  '  [ ! -e "$file" ] || exit 44',
  `  printf '%s' "$2" | base64 -d > "$file"`,
  '  chmod 644 "$file"',
  '  shift 2',
  'done',
  'sync -f "$dir" 2>/dev/null || sync'
].join('\n')

const ENSURE_DIRECTORY_SCRIPT = ['set -eu', 'mkdir -p -- "$1"'].join('\n')

// Why no chmod: the cloud installer's alias script makes the parent 0700, which would change
// the mode of the user's own agent skills folder.
const PREPARE_LINK_SCRIPT = [
  'set -eu',
  'parent=$(dirname -- "$2")',
  'mkdir -p -- "$parent"',
  `printf '%s\\0%s\\0' "$(readlink -f -- "$parent")" "$(readlink -f -- "$1")"`
].join('\n')

const CREATE_LINK_SCRIPT = [
  'set -eu',
  '[ ! -e "$2" ] && [ ! -L "$2" ] || exit 43',
  'ln -s -- "$1" "$2"',
  'sync -f "$(dirname -- "$2")" 2>/dev/null || sync'
].join('\n')

function isEntryKind(value: string | undefined): value is SkillFilesystemEntryKind {
  return (
    value === 'directory' ||
    value === 'file' ||
    value === 'symlink' ||
    value === 'other' ||
    value === 'missing'
  )
}

class WslObserveProtocolError extends Error {
  constructor() {
    super('skill-install-wsl-guest-operation-failed')
  }
}

/** Parses `WSL_OBSERVE_SCRIPT` output into observations keyed by the caller's own paths. */
export function parseWslObserveOutput(
  output: string,
  paths: readonly string[],
  toHostPath: (guestPath: string) => string
): Map<string, BundledSkillPathObservation | null> {
  const fields = output.split('\0')
  if (fields.at(-1) === '') {
    fields.pop()
  }
  const observations = new Map<string, BundledSkillPathObservation | null>()
  let cursor = 0
  const next = (): string => {
    if (cursor >= fields.length) {
      throw new WslObserveProtocolError()
    }
    return fields[cursor++]
  }
  const pathAt = (index: string): string => {
    const path = paths[Number(index)]
    if (path === undefined || !/^\d+$/u.test(index)) {
      throw new WslObserveProtocolError()
    }
    return path
  }
  let directory: { path: string; entries: SkillDirectoryEntry[]; skillFile?: Buffer } | null = null
  const closeDirectory = (): void => {
    if (directory) {
      observations.set(directory.path, {
        kind: 'directory',
        mtimeMs: null,
        entries: directory.entries,
        ...(directory.skillFile ? { skillFile: directory.skillFile } : {})
      })
      directory = null
    }
  }
  while (cursor < fields.length) {
    const tag = next()
    if (tag === 'E' && directory) {
      const name = next()
      const kind = next()
      if (!isEntryKind(kind)) {
        throw new WslObserveProtocolError()
      }
      directory.entries.push({ name, kind })
      continue
    }
    if (tag === 'S' && directory) {
      directory.skillFile = Buffer.from(next().replace(/\s/gu, ''), 'base64')
      continue
    }
    closeDirectory()
    const path = pathAt(next())
    if (tag === 'D') {
      directory = { path, entries: [] }
    } else if (tag === 'L') {
      const ok = next() === '1'
      const target = next()
      const real = next()
      observations.set(path, {
        kind: 'symlink',
        mtimeMs: null,
        linkTarget: ok ? target : null,
        linkRealPath: real ? toHostPath(real) : null
      })
    } else if (tag === 'F') {
      const kind = next()
      const seconds = next()
      if (kind !== 'file' && kind !== 'other') {
        throw new WslObserveProtocolError()
      }
      observations.set(path, { kind, mtimeMs: seconds ? Number(seconds) * 1000 : null })
    } else if (tag === 'X') {
      observations.set(path, { kind: 'directory', mtimeMs: null, entries: null })
    } else if (tag === 'M') {
      observations.set(path, { kind: 'missing', mtimeMs: null })
    } else {
      throw new WslObserveProtocolError()
    }
  }
  closeDirectory()
  if (observations.size !== new Set(paths).size) {
    throw new WslObserveProtocolError()
  }
  return observations
}

/**
 * The bundled installer's view of a WSL guest from the Windows app: metadata through guest
 * scripts (Windows can't read Linux links over `\\wsl$`), mutations confined to the agent
 * skill roots and the backups folder.
 */
export function createWslBundledSkillFilesystem(input: {
  distro: string
  homeDirectory: string
  providerRootOverrides?: SkillProviderRootOverrides
}): BundledSkillFilesystem {
  const { distro } = input
  const guarded = createWslSkillInstallFilesystem(input)
  guarded.authorizeRoots([bundledSkillBackupsRoot(input.homeDirectory)])
  const toGuest = (path: string): string => toWslGuestPath(path, distro)
  const toHost = (guestPath: string): string => toWindowsWslPath(guestPath, distro)
  const run = async (
    script: string,
    args: readonly string[],
    maxOutputBytes?: number
  ): Promise<string> => {
    const result = await runWslProcess({
      distro,
      loginPath: 'none',
      script,
      shell: 'sh',
      args,
      timeoutMs: GUEST_COMMAND_TIMEOUT_MS,
      ...(maxOutputBytes ? { maxOutputBytes } : {})
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw Object.assign(new Error('skill-install-wsl-guest-operation-failed'), {
        cause: new Error(`wsl exited ${result.code}: ${result.stderr}`)
      })
    }
    return result.stdout
  }

  return {
    supportsLinks: true,
    observe: async (paths) =>
      paths.length === 0
        ? new Map()
        : parseWslObserveOutput(
            await run(WSL_OBSERVE_SCRIPT, paths.map(toGuest), OBSERVE_MAX_OUTPUT_BYTES),
            paths,
            toHost
          ),
    realpath: async (path) => {
      const real = (await run(REALPATH_SCRIPT, [toGuest(path)])).trim()
      return real ? toHost(real) : null
    },
    canWrite: async (directory) =>
      (await run(CAN_WRITE_SCRIPT, [toGuest(directory)])).trim() === 'yes',
    writeFolder: async (path, files) => {
      await run(WRITE_FOLDER_SCRIPT, [
        guarded.requireAllowed(path),
        ...files.flatMap((file) => [file.path, Buffer.from(file.text, 'utf8').toString('base64')])
      ])
    },
    ensureDirectory: async (path) => {
      await run(ENSURE_DIRECTORY_SCRIPT, [guarded.requireAllowed(path)])
    },
    rename: (source, target) => guarded.rename(source, target),
    // Backups sit in the guest home, so this is a guest `mv` like any other rename.
    moveToBackup: (source, target) => guarded.rename(source, target),
    remove: (path) => guarded.remove(path),
    createLink: async (target, linkPath) => {
      const guestTarget = guarded.requireAllowed(target)
      const guestLink = guarded.requireAllowed(linkPath)
      const [realParent, realTarget] = (
        await run(PREPARE_LINK_SCRIPT, [guestTarget, guestLink])
      ).split('\0')
      if (!realParent || !realTarget) {
        throw new Error('skill-install-wsl-guest-operation-failed')
      }
      // Relative from the real parent, as the native installer links, so the link survives a
      // moved home and reads the same from the guest's own `orca skills`.
      await run(CREATE_LINK_SCRIPT, [posix.relative(realParent, realTarget), guestLink])
    }
  }
}
