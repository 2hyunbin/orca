const DARWIN_TERMINAL_NODE_PREFIXES = [
  'config/node-runtime-patches/',
  'config/scripts/build-darwin-terminal-node',
  'config/scripts/verify-darwin-terminal-node',
  'config/scripts/darwin-terminal-node-',
  'config/scripts/darwin-terminal-worker-stress',
  'config/scripts/pr-darwin-terminal-node-route',
  'config/scripts/__fixtures__/darwin-terminal-worker-wait',
  'config/scripts/__fixtures__/darwin-threadpool-wait',
  'config/scripts/macos-terminal-host-bundle',
  'src/shared/node-runtime-pin.ts'
]

export function isDarwinTerminalNodeSource(file) {
  return DARWIN_TERMINAL_NODE_PREFIXES.some((prefix) => file.startsWith(prefix))
}
