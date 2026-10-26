// Derive method/schema bindings from host registry; a hand-maintained catalog of 600 methods would drift from dispatcher.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import * as esbuild from 'esbuild'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const SHARED_DIR = path.join(REPO_ROOT, 'src', 'shared')
const CONTRACT_DIR = path.join(SHARED_DIR, 'rpc-contract')
const RPC_DIR = path.join(REPO_ROOT, 'src', 'main', 'runtime', 'rpc')
const REGISTRY_ENTRY = path.join(RPC_DIR, 'methods', 'method-loaders.ts')
const METADATA_PATH = path.join(RPC_DIR, 'methods', 'method-metadata.generated.ts')
const HOST_SCHEMA_MODULES = [
  path.join(RPC_DIR, 'methods', 'emulator-install-params.ts'),
  path.join(RPC_DIR, 'methods', 'orchestration', 'schemas.ts')
]
const OUTPUT_PATH = path.join(CONTRACT_DIR, 'rpc-params-catalog.generated.ts')

// Create ignored out/ before mkdtemp; keep scratch under repo for external node_modules resolution and formatter config discovery.
function scratchDir(prefix) {
  const root = path.join(REPO_ROOT, 'out')
  mkdirSync(root, { recursive: true })
  return mkdtempSync(path.join(root, prefix))
}

const posix = (value) => value.split(path.sep).join('/')
const repoPath = (absolute) => posix(path.relative(REPO_ROOT, absolute))

function indexableModules() {
  // Exclude tests or catalog’s CJS bundle requires Vitest and throws.
  const modules = new Set(
    globSync('*.ts', { cwd: CONTRACT_DIR })
      .filter((name) => !name.endsWith('.test.ts'))
      .map((name) => path.join(CONTRACT_DIR, name))
  )
  modules.delete(OUTPUT_PATH)
  for (const file of globSync('**/*.ts', { cwd: RPC_DIR })) {
    if (file.endsWith('.test.ts')) {
      continue
    }
    const source = readFileSync(path.join(RPC_DIR, file), 'utf8')
    for (const [, specifier] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const resolved = `${path.resolve(path.dirname(path.join(RPC_DIR, file)), specifier)}.ts`
      // Exclude generator output even when params import its types; stale catalog bundling would break regeneration precisely when needed.
      if (
        resolved !== OUTPUT_PATH &&
        resolved.startsWith(`${SHARED_DIR}${path.sep}`) &&
        existsSync(resolved)
      ) {
        modules.add(resolved)
      }
    }
  }
  return [...modules].sort()
}

// Bundle once so registry and schema exports share object identities.
async function loadRegistryAndSchemas(modules) {
  const buildDir = scratchDir('rpc-params-catalog-')
  try {
    const entry = path.join(buildDir, 'entry.ts')
    const importOf = (file) => JSON.stringify(posix(path.relative(buildDir, file)))
    writeFileSync(
      entry,
      [
        `export { RPC_METHOD_GROUP_LOADERS } from ${importOf(REGISTRY_ENTRY)}`,
        'export const SCHEMA_MODULES = {',
        ...modules.map(
          (file) => `  ${JSON.stringify(repoPath(file))}: require(${importOf(file)}),`
        ),
        '}',
        'export const HOST_SCHEMA_MODULES = {',
        ...HOST_SCHEMA_MODULES.map(
          (file) => `  ${JSON.stringify(repoPath(file))}: require(${importOf(file)}),`
        ),
        '}'
      ].join('\n')
    )
    const outfile = path.join(buildDir, 'bundle.cjs')
    esbuild.buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'error',
      packages: 'external',
      // Why: the catalog types every method a build can register, every dark switch's included.
      define: { ORCA_LAYOUT_OWNER: '"main"', ORCA_SIDEBAR_INPUTS: '"main"' }
    })
    const loaded = createRequire(import.meta.url)(outfile)
    const groups = Object.fromEntries(
      await Promise.all(
        Object.entries(loaded.RPC_METHOD_GROUP_LOADERS).map(async ([name, load]) => [
          name,
          await load()
        ])
      )
    )
    return {
      groups,
      methods: Object.values(groups).flat(),
      schemaModules: loaded.SCHEMA_MODULES,
      hostSchemaModules: loaded.HOST_SCHEMA_MODULES
    }
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

// Schema identity defines wire contracts; structurally equal objects remain distinct.
function buildSchemaIndex(schemaModules) {
  const index = new Map()
  for (const [modulePath, moduleExports] of Object.entries(schemaModules)) {
    for (const [exportName, value] of Object.entries(moduleExports)) {
      if (!value || typeof value !== 'object' || typeof value.safeParse !== 'function') {
        continue
      }
      if (index.has(value)) {
        continue
      }
      index.set(value, { modulePath, exportName })
    }
  }
  return index
}

function localNameFor(origin, taken) {
  if (!taken.has(origin.exportName)) {
    return origin.exportName
  }
  const hint = path
    .basename(origin.modulePath, '.ts')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  let candidate = `${origin.exportName}Of${hint}`
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `${origin.exportName}Of${hint}${suffix++}`
  }
  return candidate
}

function renderSchemaImports(imports, baseDir) {
  const byModule = new Map()
  for (const [key, local] of imports) {
    const [modulePath, exportName] = key.split('#')
    if (!byModule.has(modulePath)) {
      byModule.set(modulePath, [])
    }
    byModule.get(modulePath).push(local === exportName ? exportName : `${exportName} as ${local}`)
  }
  return [...byModule]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([modulePath, names]) => {
      let specifier = posix(path.relative(baseDir, path.join(REPO_ROOT, modulePath))).replace(
        /\.ts$/,
        ''
      )
      if (!specifier.startsWith('.')) {
        specifier = `./${specifier}`
      }
      return `import { ${names.sort().join(', ')} } from '${specifier}'`
    })
}

function render({ methods, schemaModules }) {
  const index = buildSchemaIndex(schemaModules)
  const entries = []
  const uncataloged = []
  const imports = new Map()
  const taken = new Set()

  for (const method of [...methods].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (method.params === null) {
      entries.push(`  '${method.name}': null`)
      continue
    }
    const origin = index.get(method.params)
    if (!origin) {
      uncataloged.push(method.name)
      continue
    }
    const key = `${origin.modulePath}#${origin.exportName}`
    let local = imports.get(key)
    if (!local) {
      local = localNameFor(origin, taken)
      taken.add(local)
      imports.set(key, local)
    }
    entries.push(`  '${method.name}': ${local}`)
  }

  const importLines = renderSchemaImports(imports, CONTRACT_DIR)

  return `// GENERATED by config/scripts/generate-rpc-params-catalog.mjs. Do not edit;
// run \`pnpm run generate:rpc-params-catalog\`.
import type { z } from 'zod'
${importLines.join('\n')}

// Why: the host parses params with these schemas, so a client that matches this map
// matches the dispatcher. Clients must import it for types only — parsing a params
// schema client-side runs the coercing transforms and rewrites the wire bytes.
export const RPC_PARAMS_BY_METHOD = {
${entries.join(',\n')}
} as const

// Why: these methods bind a schema the shared contract cannot hold because its value
// graph reaches into src/main. Listing them keeps the gap visible instead of absent.
export const RPC_METHODS_WITHOUT_SHARED_PARAMS: readonly string[] = [
${uncataloged.map((name) => `  '${name}'`).join(',\n')}
]

export type RpcMethodName = keyof typeof RPC_PARAMS_BY_METHOD

// Why: z.output is the post-parse shape the handler receives, which is not what a
// client may send — a .default() field reads as required. z.input is not the answer
// either: requiredString is z.unknown().transform(...), so its input admits any value.
// Senders use RpcSendParams from ./rpc-send-params, which is derived from this map.
export type RpcParams<Method extends RpcMethodName> =
  (typeof RPC_PARAMS_BY_METHOD)[Method] extends z.ZodType
    ? z.output<(typeof RPC_PARAMS_BY_METHOD)[Method]>
    : void
`
}

function renderMetadata({ groups, schemaModules, hostSchemaModules }) {
  const index = buildSchemaIndex({ ...schemaModules, ...hostSchemaModules })
  const imports = new Map()
  const taken = new Set()
  const rows = []
  for (const [name, methods] of Object.entries(groups)) {
    rows.push(`  ${name}: [`)
    for (const method of methods) {
      let params = 'null'
      if (method.params !== null) {
        const origin = index.get(method.params)
        if (!origin) {
          throw new Error(`RPC metadata needs an exported schema: ${method.name}`)
        }
        const key = `${origin.modulePath}#${origin.exportName}`
        if (!imports.has(key)) {
          const local = localNameFor(origin, taken)
          taken.add(local)
          imports.set(key, local)
        }
        params = imports.get(key)
      }
      rows.push(
        `    { name: '${method.name}', permission: '${method.permission}', params: ${params}${method.stream ? ', stream: true' : ''} },`
      )
    }
    rows.push('  ],')
  }
  const importLines = renderSchemaImports(imports, path.dirname(METADATA_PATH))
  return `// GENERATED by config/scripts/generate-rpc-params-catalog.mjs. Do not edit;
// run \`pnpm run generate:rpc-params-catalog\`.
import type { RpcMethodMetadata } from '../lazy-methods'
${importLines.join('\n')}

export const RPC_METHOD_METADATA = {
${rows.join('\n')}
} as const satisfies Record<string, readonly RpcMethodMetadata[]>
`
}

// Emit formatter-exact bytes or drift check fails every run.
function formatted(source) {
  const buildDir = scratchDir('rpc-params-catalog-fmt-')
  try {
    const file = path.join(buildDir, 'rpc-params-catalog.generated.ts')
    writeFileSync(file, source)
    const { command, prefixArgs } = resolveOxcCliInvocation('oxfmt', 'oxfmt', REPO_ROOT)
    execFileSync(command, [...prefixArgs, '--write', file], {
      stdio: 'ignore',
      windowsHide: true
    })
    return readFileSync(file, 'utf8')
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

async function main() {
  const check = process.argv.includes('--check')
  const registry = await loadRegistryAndSchemas(indexableModules())
  for (const [outputPath, source] of [
    [OUTPUT_PATH, render(registry)],
    [METADATA_PATH, renderMetadata(registry)]
  ]) {
    updateOutput(outputPath, formatted(source), check)
  }
}

function updateOutput(outputPath, generated, check) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null
  if (generated === current) {
    if (!check) {
      console.log(`rpc params catalog already up to date: ${repoPath(outputPath)}`)
    }
    return
  }
  if (check) {
    console.error(
      `${repoPath(outputPath)} is out of date. Run \`pnpm run generate:rpc-params-catalog\`.`
    )
    process.exitCode = 1
    return
  }
  writeFileSync(outputPath, generated)
  console.log(`wrote ${repoPath(outputPath)}`)
}

await main()
