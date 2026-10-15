import { vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Why: react-native cannot load in node; hooks that only listen for foreground still import it.
// A test file's own `vi.mock('react-native', ...)` replaces this one.
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
