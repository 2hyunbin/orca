import { TerminalLayoutState } from './terminal-layout-state'
import { createTerminalLayoutCommands } from './terminal-layout-construction'
import type { TerminalLayoutCommands } from './terminal-layout-commands'
import type { TerminalLayoutHost } from './terminal-layout-context'

export class TerminalLayoutController {
  private readonly state = new TerminalLayoutState()
  private readonly construction: ReturnType<typeof createTerminalLayoutCommands>

  constructor(host: TerminalLayoutHost) {
    this.construction = createTerminalLayoutCommands(this.state, host)
  }

  get commands(): TerminalLayoutCommands {
    return this.construction.commands
  }
}
