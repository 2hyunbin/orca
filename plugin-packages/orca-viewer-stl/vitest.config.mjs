import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  tsconfig: fileURLToPath(new URL('./tsconfig.json', import.meta.url))
})
