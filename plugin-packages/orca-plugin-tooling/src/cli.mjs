#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { createPluginLocaleKit, diffPluginLocaleKits } from '../dist/runtime.mjs'
import {
  inspectPackage,
  readJson,
  validateLocaleKit,
  validatePackage
} from './package-validation.mjs'
import { packRelease } from './git-release.mjs'
import { diffCatalogFiles, exportCatalogRelease } from './catalog-release.mjs'
import { createPluginTemplate } from './plugin-template.mjs'

const HELP = `orca-plugin — offline plugin authoring
  init locale|syntax|viewer|environment NEW_DIRECTORY --publisher PUBLISHER --id PACKAGE_ID
  validate DIRECTORY [--kit KIT]
  inspect DIRECTORY [--kit KIT]
  pack GIT_REPOSITORY NEW_DIRECTORY [--kit KIT]
  catalog export GIT_REPOSITORY --source HTTPS_OR_SSH_URL --ref VERSION_TAG --license LICENSE_ID [--kit KIT]
  catalog diff PREVIOUS_JSON CURRENT_JSON
  locale export ENGLISH_JSON NEW_KIT_JSON
  locale diff PREVIOUS_KIT CURRENT_KIT
JSON results go to stdout. Errors go to stderr with exit 1.
Packaging uses committed files and checks their Git blob identities. Plugin code is never executed.
`

function argumentsFor(tokens, allowed) {
  const positional = [],
    options = {}
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    const value = tokens[++index]
    if (!allowed.includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new Error(`Unknown, duplicate or missing option: ${token}`)
    }
    options[key] = value
  }
  return { positional, options }
}

async function run(tokens) {
  if (!tokens.length || (tokens.length === 1 && ['--help', '-h'].includes(tokens[0]))) {
    return { help: true }
  }
  const command = tokens[0]
  if (command === 'init') {
    const { positional, options } = argumentsFor(tokens.slice(1), ['publisher', 'id'])
    if (positional.length !== 2) {
      throw new Error('init requires a type and a new directory')
    }
    return createPluginTemplate(...positional, options)
  }
  const subcommand = ['catalog', 'locale'].includes(command) ? tokens[1] : undefined
  const allowed =
    command === 'catalog' && subcommand === 'export'
      ? ['source', 'ref', 'license', 'kit']
      : ['validate', 'inspect', 'pack'].includes(command)
        ? ['kit']
        : []
  const { positional: paths, options } = argumentsFor(tokens.slice(subcommand ? 2 : 1), allowed)
  const need = (count) => {
    if (paths.length !== count) {
      throw new Error(`Expected ${count} path argument(s). Run orca-plugin --help.`)
    }
  }
  if (command === 'validate' || command === 'inspect') {
    need(1)
    if (command === 'inspect') {
      return inspectPackage(paths[0], options)
    }
    const { manifest, ...result } = await validatePackage(paths[0], options)
    return { valid: true, ...result, version: manifest.version, execution: manifest.execution }
  }
  if (command === 'pack') {
    need(2)
    const { manifest, ...result } = await packRelease(paths[0], paths[1], options)
    return { ...result, version: manifest.version, execution: manifest.execution }
  }
  if (command === 'catalog' && subcommand === 'export') {
    need(1)
    return exportCatalogRelease(paths[0], options)
  }
  if (command === 'catalog' && subcommand === 'diff') {
    need(2)
    return diffCatalogFiles(...paths)
  }
  if (command === 'locale' && subcommand === 'export') {
    need(2)
    const kit = createPluginLocaleKit(await readJson(paths[0]))
    await writeFile(paths[1], `${JSON.stringify(kit, null, 2)}\n`, { flag: 'wx' })
    return {
      sourceRevision: kit.sourceRevision,
      entries: Object.keys(kit.entries).length,
      output: paths[1]
    }
  }
  if (command === 'locale' && subcommand === 'diff') {
    need(2)
    return diffPluginLocaleKits(
      validateLocaleKit(await readJson(paths[0])),
      validateLocaleKit(await readJson(paths[1]))
    )
  }
  throw new Error('Unknown command. Run orca-plugin --help.')
}

try {
  const result = await run(process.argv.slice(2))
  process.stdout.write(result.help ? HELP : `${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`orca-plugin: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
