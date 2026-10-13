import { writeFileSync } from 'node:fs'
import type { GrantAccessOptions, WindowsSecurityAddon } from './windows-security-addon'

export const FAKE_USER_SID = 'S-1-5-21-1-2-3-1001'

/** What an untouched path reads back as: inherited from a relocated root like `C:\orca-data`. */
export const INHERITED_SDDL = `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${FAKE_USER_SID})(A;ID;0x1301bf;;;AU)`

export type FakeWindowsSecurityCall =
  | { op: 'get' | 'set' | 'setAsync'; path: string; sddl?: string }
  | { op: 'create'; path: string; sddl: string }
  | {
      op: 'grant' | 'grantAsync'
      path: string
      sid: string
      mask: number
      options: GrantAccessOptions
    }

export type FakeWindowsSecurity = WindowsSecurityAddon & {
  calls: FakeWindowsSecurityCall[]
  /** The DACL each path reads back; absent paths read as INHERITED_SDDL. */
  dacls: Map<string, string>
  /** Paths whose writes (set, create, grant) throw. */
  failing: Set<string>
  /** When set, setDaclSddlAsync parks here instead of settling. */
  holdAsync: boolean
  /** Settles every parked setDaclSddlAsync. */
  releaseAsync: () => void
  callsFor: (op: FakeWindowsSecurityCall['op'], path?: string) => FakeWindowsSecurityCall[]
}

function win32Error(syscall: string): Error {
  return Object.assign(new Error(`${syscall} failed with Win32 error 5`), { winCode: 5, syscall })
}

/** An in-memory stand-in for native/windows-security; files it creates are real. */
export function createFakeWindowsSecurity(): FakeWindowsSecurity {
  const parked: (() => void)[] = []
  const fake: FakeWindowsSecurity = {
    calls: [],
    dacls: new Map(),
    failing: new Set(),
    holdAsync: false,
    releaseAsync: () => parked.splice(0).forEach((settle) => settle()),
    callsFor: (op, path) =>
      fake.calls.filter((call) => call.op === op && (path === undefined || call.path === path)),
    currentUserSid: () => FAKE_USER_SID,
    getDaclSddl: (path) => {
      fake.calls.push({ op: 'get', path })
      return fake.dacls.get(path) ?? INHERITED_SDDL
    },
    setDaclSddl: (path, sddl) => {
      fake.calls.push({ op: 'set', path, sddl })
      if (fake.failing.has(path)) {
        throw win32Error('SetNamedSecurityInfoW')
      }
      fake.dacls.set(path, sddl)
    },
    setDaclSddlAsync: (path, sddl) => {
      fake.calls.push({ op: 'setAsync', path, sddl })
      const settle = (resolve: () => void, reject: (error: Error) => void): void => {
        if (fake.failing.has(path)) {
          reject(win32Error('SetNamedSecurityInfoW'))
          return
        }
        fake.dacls.set(path, sddl)
        resolve()
      }
      return new Promise((resolve, reject) => {
        if (fake.holdAsync) {
          parked.push(() => settle(resolve, reject))
          return
        }
        settle(resolve, reject)
      })
    },
    createFileWithDacl: (path, sddl, data) => {
      fake.calls.push({ op: 'create', path, sddl })
      if (fake.failing.has(path)) {
        throw win32Error('CreateFileW')
      }
      writeFileSync(path, data, { flag: 'wx' })
      fake.dacls.set(path, sddl)
    },
    grantAccess: (path, sid, mask, options) => {
      fake.calls.push({ op: 'grant', path, sid, mask, options })
      if (fake.failing.has(path)) {
        throw win32Error('SetNamedSecurityInfoW')
      }
    },
    grantAccessAsync: (path, sid, mask, options) => {
      fake.calls.push({ op: 'grantAsync', path, sid, mask, options })
      return fake.failing.has(path)
        ? Promise.reject(win32Error('SetNamedSecurityInfoW'))
        : Promise.resolve()
    }
  }
  return fake
}
