import { EventEmitter } from 'node:events'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadSshDirectory, type SshFileTransferHost } from './ssh-connection-file-transfers'

// What ssh2 does once the connection dies: the session closes, and a request sent after that (or a
// write stream's CLOSE) is never answered, so the transfer itself never settles.
vi.mock('../sftp-upload', () => ({ uploadDirectory: vi.fn(() => new Promise<void>(() => {})) }))

function hostWith(sftp: EventEmitter): SshFileTransferHost {
  return {
    target: { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' },
    usesSystemSshTransport: () => false,
    systemOperationSignal: () => new AbortController().signal,
    systemSshBuildArgsOptions: () => ({}),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transfer only listens to the session and ends it.
    sftp: async () => sftp as unknown as SFTPWrapper
  }
}

function fakeSession(): EventEmitter & { end: () => void; ended: number } {
  return Object.assign(new EventEmitter(), {
    ended: 0,
    end(this: { ended: number }) {
      this.ended += 1
    }
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('an SFTP transfer whose SSH connection dies', () => {
  it('fails as lost contact instead of waiting forever', async () => {
    const sftp = fakeSession()
    const upload = uploadSshDirectory(hostWith(sftp), '/local/runtime', '/root/.orca-remote/x')
    await vi.waitFor(async () => {
      const { uploadDirectory } = await import('../sftp-upload')
      expect(uploadDirectory).toHaveBeenCalled()
    })
    sftp.emit('close')
    await expect(upload).rejects.toMatchObject({
      name: 'SftpSessionClosedError',
      sshChannelCloseConfirmed: false
    })
    expect(sftp.listenerCount('close')).toBe(0)
  })
})
