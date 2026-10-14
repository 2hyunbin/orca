import assert from 'node:assert/strict'
import path from 'node:path'
import { build } from 'esbuild'

// Runtime bundling keeps independent consumer assertions outside shared project type graphs.
export async function loadAnsiConsumers(root = process.cwd()) {
  const entries = [
    ['parseAnsiSegments', 'renderer/src/components/editor/ipynb-ansi'],
    [
      'restoredSnapshotPaintsPrintableContent',
      'renderer/src/components/terminal-pane/restored-snapshot-coverage'
    ],
    ['parseCodexLoginAuthUrl', 'main/codex-accounts/codex-login-auth-url'],
    ['TerminalCommandPaint', 'main/runtime/terminal-command-paint'],
    ['claudePermissionSubject', 'main/claude/claude-permission-presentation'],
    ['terminalSafe', 'cli/agent-session-search-format'],
    [
      'createAutomationRunOutputSnapshotBuffer',
      'renderer/src/components/automations/automation-run-output-snapshot'
    ]
  ]
  const bundle = await build({
    stdin: {
      contents: entries
        .map(([name, filename]) => `export { ${name} } from './${filename}';`)
        .join('\n'),
      resolveDir: path.join(root, 'src'),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  const consumers = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  )
  for (const [name] of entries) {
    assert.equal(typeof consumers[name], 'function', `Missing actual consumer: ${name}`)
  }
  return consumers
}
