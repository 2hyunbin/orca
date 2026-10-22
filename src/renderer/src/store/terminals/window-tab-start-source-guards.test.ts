// Source guards for the window tab's start in main (L252): what the window sends is its own main's,
// and main alone records the start's telemetry.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = join(__dirname, '..', '..')

function rendererSources(dir = RENDERER_SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return rendererSources(path)
    }
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : []
  })
}

describe('window tab start source guards', () => {
  const sources = rendererSources().map((path) => ({
    path: relative(RENDERER_SRC, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8')
  }))

  it('sends a windowTab terminal.create only to this window’s own main process', () => {
    const senders = sources.filter(({ text }) => /windowTab:\s*true/.test(text))
    expect(senders.map(({ path }) => path)).toEqual(['store/terminals/window-tab-start-in-main.ts'])
    for (const { text } of senders) {
      expect(text).toMatch(/callRuntimeRpc<[^>]*>\(\{ kind: 'local' \}, 'terminal\.create', \{/)
    }
  })

  it('records agent_started nowhere in the window: main records it once its spawn commits', () => {
    const recorders = sources.filter(({ text }) => /track\(\s*['"]agent_started['"]/.test(text))
    expect(recorders.map(({ path }) => path)).toEqual([])
  })
})
