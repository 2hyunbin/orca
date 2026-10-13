import type { Plugin } from 'vite'

export function createSandboxedPreloadGuardPlugin(entryNames: readonly string[]): Plugin {
  return {
    name: 'orca-sandboxed-preload-guard',
    generateBundle(_options, bundle) {
      for (const name of entryNames) {
        const chunk = Object.values(bundle).find(
          (entry) => entry.type === 'chunk' && entry.isEntry && entry.name === name
        )
        if (!chunk || chunk.type !== 'chunk') {
          throw new Error(`sandboxed_preload_missing: ${name}`)
        }
        const dependencies = [...chunk.imports, ...chunk.dynamicImports].filter(
          (specifier) => specifier !== 'electron'
        )
        for (const match of chunk.code.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
          if (match[1] !== 'electron') {
            dependencies.push(match[1] ?? 'unknown')
          }
        }
        // Electron's sandboxed preload loader cannot resolve local helper chunks.
        if (dependencies.length) {
          throw new Error(`sandboxed_preload_dependency: ${name}: ${dependencies.join(', ')}`)
        }
      }
    }
  }
}
