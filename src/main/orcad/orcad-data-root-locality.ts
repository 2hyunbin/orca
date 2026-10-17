/**
 * Whether a data root sits on a disk only this machine mounts. An instance-lock record that names
 * no machine is judged by its PID only when this holds: on a network home another machine may be
 * running it, and a PID is evidence only on the machine that issued it.
 */
import { statfsSync } from 'node:fs'
import process from 'node:process'
import { runProcessSync } from '@orca/process-host'

// Linux `statfs` f_type magics (linux/magic.h) of local disk and memory filesystems.
const LINUX_LOCAL_FILESYSTEM_MAGICS = new Set([
  0xef53, // ext2/3/4
  0x58465342, // xfs
  0x9123683e, // btrfs
  0x2fc12fc1, // zfs
  0xca451a4e, // bcachefs
  0xf2f52010, // f2fs
  0x3153464a, // jfs
  0x52654973, // reiserfs
  0x3434, // nilfs
  0x01021994, // tmpfs
  0x858458f6, // ramfs
  0x794c7630, // overlayfs
  0xf15f, // ecryptfs
  0x4d44, // vfat
  0x2011bab0, // exfat
  0x482b // hfsplus
])

export function orcadDataRootIsOnLocalDisk(
  dataRoot: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  try {
    if (platform === 'linux') {
      return LINUX_LOCAL_FILESYSTEM_MAGICS.has(statfsSync(dataRoot).type)
    }
    if (platform === 'win32') {
      // Mapped network drives still resolve to a drive letter; only UNC is provably remote.
      return !/^[\\/]{2}/u.test(dataRoot)
    }
    // macOS numbers its filesystem types per boot, so its df source names the device instead.
    const result = runProcessSync({
      program: '/bin/df',
      args: ['-P', dataRoot],
      timeoutMs: 2_000,
      maxOutputBytes: 16 * 1024
    })
    const source =
      result.code === 0 ? result.stdout.trim().split('\n').at(-1)?.split(/\s+/u)[0] : ''
    return Boolean(source?.startsWith('/dev/'))
  } catch {
    return false
  }
}
