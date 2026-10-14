import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { createRequire } from 'node:module'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  orcadTemplateCommonFilenames,
  orcadTemplateTargetFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { ORCAD_TEMPLATE_TARGETS, COMPAT_SERVER_TARGETS } from '../../src/shared/node-runtime-pin.ts'

const require = createRequire(import.meta.url)
const { verifyPackagedOrcadTemplate } = require('./verify-packaged-orcad-template.cjs')

function canonicalPath(path) {
  const absolute = resolve(path)
  let ancestor = absolute
  while (!existsSync(ancestor)) {
    ancestor = dirname(ancestor)
  }
  return join(realpathSync(ancestor), relative(ancestor, absolute))
}

function contains(parent, child) {
  const path = relative(canonicalPath(parent), canonicalPath(child))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function requireMatchingServer(packageDir, templateDir) {
  for (const filename of orcadTemplateCommonFilenames()) {
    if (
      !readFileSync(join(packageDir, filename)).equals(readFileSync(join(templateDir, filename)))
    ) {
      throw new Error(`The deployment template was built from different server bytes: ${filename}`)
    }
  }
}

export function verifyControlHostTemplate(
  packageDir,
  templateDir,
  targets = ORCAD_TEMPLATE_TARGETS
) {
  if (contains(packageDir, templateDir) || contains(templateDir, packageDir)) {
    throw new Error('The deployment template must be outside the server package')
  }
  if (resolve(templateDir) !== join(dirname(resolve(templateDir)), 'orcad-template')) {
    throw new Error('The deployment template directory must be named orcad-template')
  }
  verifyPackagedOrcadTemplate(dirname(templateDir), targets)
}

/** Copy only declared files; verify again so a source change cannot publish unchecked bytes. */
export function stageControlHostTemplate(
  packageDir,
  templateDir,
  targets = ORCAD_TEMPLATE_TARGETS
) {
  verifyControlHostTemplate(packageDir, templateDir, targets)
  requireMatchingServer(packageDir, templateDir)
  const manifest = JSON.parse(
    readFileSync(join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME), 'utf8')
  )
  const inventory = [...orcadTemplateCommonFilenames(), ORCAD_TEMPLATE_MANIFEST_FILENAME]
  for (const target of [
    ...targets,
    ...COMPAT_SERVER_TARGETS.filter((target) => Object.hasOwn(manifest.targets, target))
  ]) {
    const filenames = orcadTemplateTargetFilenames(target)
    if (manifest.targets[target].browserName) {
      filenames.push(manifest.targets[target].browserName)
    }
    for (const filename of filenames) {
      inventory.push(join(ORCAD_TEMPLATE_TARGETS_DIR, target, filename))
    }
  }
  const resources = join(packageDir, 'resources')
  mkdirSync(resources, { recursive: true })
  const staging = mkdtempSync(join(resources, '.orcad-template-'))
  const destination = join(staging, 'orcad-template')
  try {
    for (const filename of inventory) {
      const path = join(destination, filename)
      mkdirSync(dirname(path), { recursive: true })
      copyFileSync(join(templateDir, filename), path)
    }
    verifyPackagedOrcadTemplate(staging, targets)
    requireMatchingServer(packageDir, destination)
    const published = join(resources, 'orcad-template')
    if (existsSync(published)) {
      throw new Error('The server package already contains a deployment template')
    }
    renameSync(destination, published)
    return published
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
