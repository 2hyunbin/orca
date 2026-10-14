import { pluginEnvironmentRecipePreview } from './plugin-environment-recipe-preview'
import { describe, expect, it } from 'vitest'
import {
  environmentRecipeDeclaredActions,
  environmentRecipeProviderId,
  parsePluginEnvironmentRecipe,
  validateEnvironmentRecipeCreateParameters,
  environmentRecipeAdapterPaths
} from './plugin-environment-recipe-artifact'

const command = { program: 'devctl', args: ['pods', 'list'] }
const raw = {
  schemaVersion: 1,
  id: 'devpods',
  name: 'Development pods',
  description: 'Manage your company development environments.',
  lifetime: 'both',
  commands: {
    list: command,
    create: { ...command, args: ['pods', 'create'] },
    delete: command,
    sleep: command,
    resume: command,
    archive: command
  },
  createFields: [{ id: 'region', label: 'Region', required: true, choices: ['east', 'west'] }]
}
const parse = (value: unknown) => parsePluginEnvironmentRecipe(JSON.stringify(value))

describe('plugin environment recipe artifacts', () => {
  it('declares contained prebuilt adapters for lifecycle and receipt inspection without executing them', () => {
    const adapter = {
      program: 'orca:node',
      entry: 'adapters/devpods.mjs',
      args: ['literal; argument']
    }
    const recipe = parse({
      ...raw,
      protocolVersion: 2,
      commands: { list: adapter },
      createFields: [],
      recovery: { protocolVersion: 1, command: { ...adapter, entry: 'adapters/receipts.mjs' } }
    })
    expect(environmentRecipeAdapterPaths(recipe)).toEqual([
      'adapters/devpods.mjs',
      'adapters/receipts.mjs'
    ])
    expect(pluginEnvironmentRecipePreview('company.platform', recipe).commands).toMatchObject([
      {
        action: 'list',
        program: 'orca:node',
        entry: 'adapters/devpods.mjs',
        args: ['literal; argument']
      },
      { action: 'inspect-operation', entry: 'adapters/receipts.mjs' }
    ])
  })
  it.each([
    '../escape.mjs',
    '/absolute.mjs',
    'C:\\escape.mjs',
    '.git/adapter.mjs',
    'node_modules/adapter.mjs',
    'adapters/con.mjs',
    'adapters/source.ts',
    'adapters/source.cjs',
    'adapters/bad\0.mjs'
  ])('refuses nonportable or unreviewed adapter paths: %s', (entry) => {
    expect(() =>
      parse({
        ...raw,
        protocolVersion: 2,
        createFields: [],
        commands: { list: { program: 'orca:node', entry, args: [] } }
      })
    ).toThrow()
  })
  it('requires the reserved runtime, explicit entry and context-aware provider protocol together', () => {
    for (const command of [
      { program: 'orca:node', args: [] },
      { program: 'orca:future', entry: 'adapter.mjs', args: [] },
      { program: 'external-node', entry: 'adapter.mjs', args: [] }
    ]) {
      expect(() =>
        parse({ ...raw, protocolVersion: 2, createFields: [], commands: { list: command } })
      ).toThrow()
    }
    expect(() =>
      parse({
        ...raw,
        createFields: [],
        commands: { list: { program: 'orca:node', entry: 'adapter.mjs', args: [] } }
      })
    ).toThrow('protocol 2')
  })
  it('declares every lifecycle action and independent provider identity', () => {
    const recipe = parse(raw)
    expect(environmentRecipeDeclaredActions(recipe)).toEqual([
      'create',
      'delete',
      'sleep',
      'list',
      'resume',
      'archive'
    ])
    expect(environmentRecipeProviderId('company.platform', recipe)).toBe('company.platform/devpods')
    expect(() => environmentRecipeProviderId('unqualified', recipe)).toThrow('qualified')
    expect(recipe.commands.list.timeoutSeconds).toBe(120)
  })
  it.each([
    { ...raw, permissions: 'all' },
    { ...raw, commands: { list: { ...command, shell: true } } },
    { ...raw, commands: { list: { ...command, env: { TOKEN: 'secret' } } } },
    { ...raw, commands: { list: { ...command, timeoutSeconds: 0 } } },
    { ...raw, commands: { list: { ...command, program: 'dev\0ctl' } } },
    { ...raw, commands: { list: command, sleep: command } },
    { ...raw, commands: { create: command } },
    { ...raw, createFields: [...raw.createFields, ...raw.createFields] }
  ])('fails closed for unknown or unsafe declarations', (value) => {
    expect(() => parse(value)).toThrow()
  })
  it('opts into context-aware protocol 2 without changing legacy artifacts', () => {
    expect(parse(raw).protocolVersion).toBeUndefined()
    expect(parse({ ...raw, protocolVersion: 2 }).protocolVersion).toBe(2)
    expect(() => parse({ ...raw, protocolVersion: 3 })).toThrow()
    expect(() => parse({ ...raw, contextId: 'author-selected-account' })).toThrow()
  })
  it('requires declared create values and leaves author strings literal', () => {
    const recipe = parse(raw)
    expect(() =>
      validateEnvironmentRecipeCreateParameters(recipe, { region: 'east' })
    ).not.toThrow()
    expect(() => validateEnvironmentRecipeCreateParameters(recipe, {})).toThrow('required')
    expect(() =>
      validateEnvironmentRecipeCreateParameters(recipe, { region: 'elsewhere' })
    ).toThrow('choices')
    expect(() =>
      validateEnvironmentRecipeCreateParameters(recipe, { region: 'east', command: 'rm' })
    ).toThrow('declared')
    expect(
      parse({
        ...raw,
        commands: {
          ...raw.commands,
          list: { ...command, args: ['$(touch /tmp/example)', 'one; two', '{{tenant}}'] }
        }
      }).commands.list.args
    ).toEqual(['$(touch /tmp/example)', 'one; two', '{{tenant}}'])
  })
  it('supports a provider that only lists existing long-lived machines', () => {
    const recipe = parse({
      ...raw,
      lifetime: 'long-lived',
      commands: { list: command },
      createFields: []
    })
    expect(environmentRecipeDeclaredActions(recipe)).toEqual(['list'])
    expect(() => validateEnvironmentRecipeCreateParameters(recipe, {})).toThrow('support create')
  })
  it('bounds bytes and nesting before parsing', () => {
    expect(() => parsePluginEnvironmentRecipe(' '.repeat(64 * 1024 + 1))).toThrow('byte limit')
    expect(() => parsePluginEnvironmentRecipe(`${'['.repeat(20)}0${']'.repeat(20)}`)).toThrow(
      'nesting'
    )
  })
  it('requires explicit context-aware recovery support and includes its literal command in review', () => {
    const recovery = {
      protocolVersion: 1,
      command: { program: 'company-dev', args: ['inspect-operation'] }
    }
    expect(() => parsePluginEnvironmentRecipe(JSON.stringify({ ...raw, recovery }))).toThrow(
      'protocol 2'
    )
    const recipe = parsePluginEnvironmentRecipe(
      JSON.stringify({ ...raw, protocolVersion: 2, recovery })
    )
    const preview = pluginEnvironmentRecipePreview('company.platform', recipe)
    expect(preview.commands.at(-1)).toMatchObject({
      action: 'inspect-operation',
      program: 'company-dev',
      args: ['inspect-operation']
    })
    expect(environmentRecipeDeclaredActions(recipe)).toHaveLength(6)
  })
})
