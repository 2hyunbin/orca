import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { canonicalDirectoryTokens } from './plugin-directory-design-tokens'

it('uses the actual app theme without copying terminal/editor styles or guessing fallback colors', async () => {
  const css = await readFile(resolve('src/renderer/src/assets/main.css'), 'utf8')
  const tokens = canonicalDirectoryTokens(css)
  expect(tokens).toContain('--app-font-family:')
  expect(tokens).toContain('--background:')
  expect(tokens).toContain('.dark {')
  expect(tokens).toContain('--shadow-floating:')
  expect(tokens).not.toContain('.xterm')
  expect(() => canonicalDirectoryTokens(':root {}')).toThrow('missing')
})
