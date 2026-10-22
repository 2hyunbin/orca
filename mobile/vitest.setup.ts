import { vi } from 'vitest'

// Native SVG's generated components import Flow-only native subpaths outside the RN host mocks.
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Defs: 'Defs',
  G: 'G',
  LinearGradient: 'LinearGradient',
  Path: 'Path',
  Rect: 'Rect',
  Stop: 'Stop'
}))

// Node has neither libsodium's JSI functions nor the codec module, so tests run the JS path a
// binary without them falls back to; bundle-window-native-codec.test.ts swaps in real libsodium.
vi.mock('./src/transport/bundle-window-native-bindings', () => ({
  loadBundleWindowNativeBindings: () => null
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
