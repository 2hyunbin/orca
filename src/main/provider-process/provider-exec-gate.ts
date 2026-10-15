import { Duplex } from 'node:stream'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'

// No provider instruction runs until the surviving watcher owns this shell's group.
export const PROVIDER_EXEC_GATE_SCRIPT = `
IFS= read -r permit <&3 || exit 125
[ "$permit" = exec ] || exit 125
if ! command -v "$1" >/dev/null 2>&1; then
  printf 'ENOENT\\n' >&3
  exit 127
fi
exec 3<&-
exec "$@"
`

export function providerExecGate(
  child: Pick<ChildProcessHandle, 'stdio' | 'emit' | 'listenerCount'>,
  command: string
): {
  ready(): boolean
  failed(error: Error): void
} {
  const gate = child.stdio[3]
  const fail = (error: Error): void => {
    gate?.destroy()
    // All registered groups are contained before arbitrary consumer listeners run.
    queueMicrotask(() => {
      if (child.listenerCount('error') > 0) {
        child.emit('error', error)
      }
    })
  }
  if (!(gate instanceof Duplex)) {
    return {
      ready: () => false,
      failed: fail
    }
  }
  gate.on('error', () => {})
  let diagnostic = ''
  gate.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostic += chunk
    if (diagnostic === 'ENOENT\n') {
      child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), {
        code: 'ENOENT', path: command
      }))
    }
  })
  return {
    ready: () => {
      gate.write('exec\n')
      return true
    },
    failed: fail
  }
}
