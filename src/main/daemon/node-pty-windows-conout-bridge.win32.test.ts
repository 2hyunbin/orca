import { Socket } from 'node:net'
import { spawn, type IPty } from 'node-pty'
import { describe, expect, it } from 'vitest'

/** node-pty's private Windows agent; `outSocket` is the reader its conout worker writes into. */
type WindowsPtyAgent = { outSocket: Socket }

function parseWindowsPtyAgent(terminal: IPty): WindowsPtyAgent {
  const agent: unknown = '_agent' in terminal ? terminal._agent : undefined
  if (
    typeof agent !== 'object' ||
    agent === null ||
    !('outSocket' in agent) ||
    !(agent.outSocket instanceof Socket)
  ) {
    throw new Error('node-pty Windows agent exposes no output socket')
  }
  return { outSocket: agent.outSocket }
}

const DEVICE_ATTRIBUTES_QUERY = '\x1b[c'

function waitForOutputBytes(terminal: IPty, minBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const timeout = setTimeout(
      () => reject(new Error(`Timed out after ${bytes} of ${minBytes} output bytes`)),
      10_000
    )
    terminal.onData((chunk) => {
      // Bundled ConPTY holds output until the terminal answers its DA1 query.
      if (chunk.includes(DEVICE_ATTRIBUTES_QUERY)) {
        terminal.write('\x1b[?61;4c')
      }
      bytes += chunk.length
      if (bytes >= minBytes) {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
}

describe.skipIf(process.platform !== 'win32')('node-pty Windows conout bridge', () => {
  it('keeps the host alive when the output reader closes while ConPTY is still writing', async () => {
    const uncaught: unknown[] = []
    const uncaughtListener = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', uncaughtListener)

    let terminal: IPty | undefined
    try {
      terminal = spawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/c', 'for /L %i in (1,1,2000000) do @echo %i-conout-bridge-flood-line'],
        { cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConptyDll: true }
      )
      await waitForOutputBytes(terminal, 64 * 1024)
      // A paused reader leaves the conout worker with queued writes, so closing
      // the reader deterministically fails one of them with EPIPE.
      terminal.pause()
      await new Promise((resolve) => setTimeout(resolve, 500))
      parseWindowsPtyAgent(terminal).outSocket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      expect(uncaught).toEqual([])
    } finally {
      try {
        terminal?.kill()
      } catch {}
      // The conout worker terminates on a delay after kill(); keep the guard through it.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      process.off('uncaughtException', uncaughtListener)
    }
  }, 20_000)
})
