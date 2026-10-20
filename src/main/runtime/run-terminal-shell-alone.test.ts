import { describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as ProcessTableSnapshotReader from '../../shared/process-table-snapshot-reader'
import {
  confirmRootShellHasNoChildrenFromProcessTable,
  inspectionShowsShellAlone
} from './run-terminal-shell-alone'

const strictCapture = vi.hoisted(() => vi.fn<() => Promise<ProcessTableRow[]>>())
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableSnapshotReader>()),
  getFreshProcessTableSnapshot: strictCapture
}))

// macOS wraps the login shell in `/usr/bin/login`, so the PTY's root is not the shell.
const LOGIN = {
  pid: 100,
  ppid: 1,
  tty: 'ttys004',
  stat: 'Ss',
  command: '/usr/bin/login -flp me /bin/zsh'
}
const SHELL = { pid: 101, ppid: 100, tty: 'ttys004', stat: 'S+', command: '-zsh' }

describe('confirmRootShellHasNoChildrenFromProcessTable (the POSIX exit proof)', () => {
  it('proves the shell alone under its login wrapper', async () => {
    strictCapture.mockResolvedValue([LOGIN, SHELL])
    expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(true)
  })

  it('never proves it while an agent runs in the background of the foreground shell', async () => {
    strictCapture.mockResolvedValue([
      LOGIN,
      SHELL,
      { pid: 102, ppid: 101, tty: 'ttys004', stat: 'S', command: 'omp' }
    ])
    expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(false)
  })

  it('proves nothing from a capture with a malformed row', async () => {
    strictCapture.mockRejectedValue(new Error('malformed process row'))
    expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(false)
  })
})

describe('inspectionShowsShellAlone (the Windows proof)', () => {
  it('proves a shell alone only on an observed empty child census', () => {
    expect(
      inspectionShowsShellAlone({
        foregroundProcess: 'pwsh.exe',
        hasChildProcesses: false,
        childProcessEvidence: 'no-children'
      })
    ).toBe(true)
  })

  it.each([
    [
      'a child still runs',
      {
        foregroundProcess: 'node.exe',
        hasChildProcesses: true,
        childProcessEvidence: 'children' as const
      }
    ],
    [
      'the host could not read its process table',
      {
        foregroundProcess: 'pwsh.exe',
        hasChildProcesses: false,
        childProcessEvidence: 'unverifiable' as const
      }
    ],
    [
      'an older host sent no child census',
      { foregroundProcess: 'pwsh.exe', hasChildProcesses: false }
    ],
    [
      'the host could not be reached',
      {
        foregroundProcess: null,
        hasChildProcesses: false as const,
        verdict: 'unverifiable' as const,
        reason: 'timeout'
      }
    ]
  ])('stays unproven when %s', (_case, inspection) => {
    expect(inspectionShowsShellAlone(inspection)).toBe(false)
    expect(inspectionShowsShellAlone(null)).toBe(false)
  })
})
