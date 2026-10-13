import { readFile } from 'node:fs/promises'
import type { Plugin } from 'vite'

const MARKER = '/* ORCA_CANONICAL_DESIGN_TOKENS */'

export function canonicalDirectoryTokens(css: string): string {
  return ['@theme inline', ':root', '.dark']
    .map((selector) => {
      const start = css.indexOf(`${selector} {`)
      const end = css.indexOf('}', start)
      if (start === -1 || end < start) {
        throw new Error(`Canonical design tokens missing: ${selector}`)
      }
      return css.slice(start, end + 1)
    })
    .join('\n\n')
}

export function pluginDirectoryDesignTokens(canonicalCss: string): Plugin {
  return {
    name: 'orca-plugin-directory-design-tokens',
    enforce: 'pre',
    async transform(source, id) {
      if (!id.split('?')[0]?.endsWith('/plugin-directory.css')) {
        return null
      }
      if (!source.includes(MARKER)) {
        throw new Error('Plugin directory design token marker missing')
      }
      this.addWatchFile(canonicalCss)
      return source.replace(MARKER, canonicalDirectoryTokens(await readFile(canonicalCss, 'utf8')))
    }
  }
}
