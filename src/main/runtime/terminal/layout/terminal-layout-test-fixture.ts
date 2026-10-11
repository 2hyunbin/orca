import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeTerminalDriverController } from '../../runtime-terminal-driver-controller'
import { RuntimeTerminalViewSubscribers } from '../../runtime-terminal-view-subscribers'
import { TerminalLayoutController } from './terminal-layout-controller'
import { TerminalLayoutState } from './terminal-layout-state'
import type { TerminalLayoutCommands } from './terminal-layout-commands'

function readLayoutOwner(runtime: OrcaRuntimeService): TerminalLayoutController {
  const owner: unknown = Object.getOwnPropertyDescriptor(runtime, 'terminalLayout')?.value
  if (!(owner instanceof TerminalLayoutController)) {
    throw new Error('Runtime does not own a terminal layout controller')
  }
  return owner
}

export function getTerminalLayoutStateForTest(
  runtime: OrcaRuntimeService
): Readonly<TerminalLayoutState> {
  const state: unknown = Object.getOwnPropertyDescriptor(readLayoutOwner(runtime), 'state')?.value
  if (!(state instanceof TerminalLayoutState)) {
    throw new Error('Terminal layout owner does not hold its state')
  }
  return state
}

function readLayoutComponent(
  runtime: OrcaRuntimeService,
  name: 'drivers' | 'viewSubscribers'
): unknown {
  const construction: unknown = Object.getOwnPropertyDescriptor(
    readLayoutOwner(runtime),
    'construction'
  )?.value
  if (!construction || typeof construction !== 'object') {
    throw new Error('Terminal layout owner does not hold its components')
  }
  return Object.getOwnPropertyDescriptor(construction, name)?.value
}

export function getTerminalLayoutDriversForTest(
  runtime: OrcaRuntimeService
): RuntimeTerminalDriverController {
  const drivers = readLayoutComponent(runtime, 'drivers')
  if (!(drivers instanceof RuntimeTerminalDriverController)) {
    throw new Error('Terminal layout owner does not hold its driver controller')
  }
  return drivers
}

export function getTerminalViewSubscribersForTest(
  runtime: OrcaRuntimeService
): RuntimeTerminalViewSubscribers {
  const subscribers = readLayoutComponent(runtime, 'viewSubscribers')
  if (!(subscribers instanceof RuntimeTerminalViewSubscribers)) {
    throw new Error('Terminal layout owner does not hold its view subscribers')
  }
  return subscribers
}

export function getTerminalLayoutCommandsForTest(
  runtime: OrcaRuntimeService
): TerminalLayoutCommands {
  return readLayoutOwner(runtime).commands
}
