import type { GitExecOptions } from './git-exec-options'
import type { ResolvedCommand } from './wsl-command-resolution'

/** Lower priority inside the execution kernel so Git's pack children inherit it. */
export function lowPriorityGitCommand(
  command: ResolvedCommand,
  options: Pick<GitExecOptions, 'terminationBarrier' | 'spawnOnWorkerThread'> = {}
): ResolvedCommand {
  if (options.terminationBarrier || options.spawnOnWorkerThread) {
    throw new Error('Low-priority Git requires direct buffered capture.')
  }
  if (command.wsl) {
    const execIndex = command.args.indexOf('--exec')
    if (execIndex === -1) {
      throw new Error('Cannot lower priority of a WSL command without --exec')
    }
    return {
      ...command,
      args: [
        ...command.args.slice(0, execIndex + 1),
        '/usr/bin/nice',
        '-n',
        '10',
        ...command.args.slice(execIndex + 1)
      ]
    }
  }
  if (process.platform === 'win32') {
    return command
  }
  return {
    ...command,
    binary: '/usr/bin/nice',
    args: ['-n', '10', command.binary, ...command.args]
  }
}
