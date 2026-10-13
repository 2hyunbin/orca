import type { ElectronApplication } from '@stablyai/playwright-test'

type ViewerInput =
  | {
      kind: 'key'
      key: 'Enter' | 'Escape' | 'PageDown' | 'Home' | 'End' | 'ArrowLeft' | 'c'
      modifiers?: ('meta' | 'control')[]
    }
  | { kind: 'click-copy' }

export async function sendViewerInput(app: ElectronApplication, input: ViewerInput): Promise<void> {
  await app.evaluate(async ({ webContents }, input) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().startsWith('orca-plugin-viewer://'))
    if (!guest) {
      throw new Error('viewer guest unavailable')
    }
    const attached = !guest.debugger.isAttached()
    if (attached) {
      guest.debugger.attach('1.3')
    }
    let sessionId: string | undefined
    try {
      const own = await guest.debugger.sendCommand('Target.getTargetInfo')
      const targets = await guest.debugger.sendCommand('Target.getTargets')
      const frame = targets.targetInfos.find(
        (target: { type: string; parentId?: string }) =>
          target.type === 'iframe' && target.parentId === own.targetInfo.targetId
      )
      if (!frame) {
        throw new Error('viewer frame target unavailable')
      }
      const session: unknown = await guest.debugger.sendCommand('Target.attachToTarget', {
        targetId: frame.targetId,
        flatten: true
      })
      if (
        !session ||
        typeof session !== 'object' ||
        !('sessionId' in session) ||
        typeof session.sessionId !== 'string'
      ) {
        throw new Error('viewer frame session unavailable')
      }
      sessionId = session.sessionId
      await guest.debugger.sendCommand(
        'Emulation.setFocusEmulationEnabled',
        { enabled: true },
        sessionId
      )
      if (input.kind === 'click-copy') {
        const result = await guest.debugger.sendCommand(
          'Runtime.evaluate',
          {
            expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Copy value'); const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
            returnByValue: true
          },
          sessionId
        )
        await guest.debugger.sendCommand(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', button: 'left', clickCount: 1, ...result.result.value },
          sessionId
        )
        await guest.debugger.sendCommand(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', button: 'left', clickCount: 1, ...result.result.value },
          sessionId
        )
        return
      }
      const key = input.key
      const modifiers = input.modifiers ?? []
      const windowsVirtualKeyCode = {
        Enter: 13,
        Escape: 27,
        PageDown: 34,
        Home: 36,
        End: 35,
        ArrowLeft: 37,
        c: 67
      }[key]
      const flags = (modifiers.includes('meta') ? 4 : 0) | (modifiers.includes('control') ? 2 : 0)
      await guest.debugger.sendCommand(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key, windowsVirtualKeyCode, modifiers: flags },
        sessionId
      )
      await guest.debugger.sendCommand(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key, windowsVirtualKeyCode, modifiers: flags },
        sessionId
      )
    } finally {
      if (sessionId) {
        await guest.debugger.sendCommand(
          'Emulation.setFocusEmulationEnabled',
          { enabled: false },
          sessionId
        )
        await guest.debugger.sendCommand('Target.detachFromTarget', { sessionId })
      }
      if (attached) {
        guest.debugger.detach()
      }
    }
  }, input)
}
