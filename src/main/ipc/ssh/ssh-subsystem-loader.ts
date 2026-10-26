import { quitTeardownStartGate } from '../../quit-teardown-start-gate'

export function createSshSubsystemLoader<Module, Subsystem>(
  load: () => Promise<Module>,
  initialize: (module: Module) => Subsystem
) {
  let pending: Promise<Subsystem> | undefined
  let loaded: Subsystem | undefined
  const assertRunning = (): void => {
    if (quitTeardownStartGate.hasStarted()) {
      throw new Error('SSH connects are closed for app shutdown')
    }
  }
  return {
    get loaded(): Subsystem | undefined {
      return loaded
    },
    load(): Promise<Subsystem> {
      if (quitTeardownStartGate.hasStarted()) {
        return Promise.reject(new Error('SSH connects are closed for app shutdown'))
      }
      pending ??= Promise.resolve()
        .then(() => {
          assertRunning()
          return load()
        })
        .then((module) => {
          assertRunning()
          loaded = initialize(module)
          return loaded
        })
        .catch((error: unknown) => {
          pending = undefined
          throw error
        })
      return pending
    }
  }
}
