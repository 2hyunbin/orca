import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import typstGrammar from '../../../src/renderer/src/lib/monaco-languages/textmate-grammars/typst.tmLanguage.json'
import { pluginManifestSchema } from '../../../src/shared/plugins/plugin-manifest'

export async function writePluginSyntaxFixture(
  directory: string,
  kind: 'typst' | 'sample',
  conflict = false
): Promise<void> {
  await mkdir(directory, { recursive: true })
  const id = kind === 'typst' ? 'typst' : 'sample'
  const grammar =
    kind === 'typst'
      ? typstGrammar
      : {
          scopeName: 'source.sample',
          patterns: [
            { begin: '/\\*', end: '\\*/', name: 'comment.block.sample' },
            { match: '\\b(?:launch|finish)\\b', name: 'keyword.control.sample' },
            { match: '\\b[0-9]+\\b', name: 'constant.numeric.sample' },
            { begin: '"', end: '"', name: 'string.quoted.sample' }
          ]
        }
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'data',
    id: `orca-syntax-${kind}`,
    publisher: 'stablyai',
    name: kind === 'typst' ? 'Typst syntax' : 'Sample syntax',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      languages: [
        {
          id,
          aliases: [kind === 'typst' ? 'Typst' : 'Sample'],
          extensions:
            kind === 'typst'
              ? ['.typst', '.typ']
              : conflict
                ? ['.orcasample', '.typst']
                : ['.orcasample'],
          configuration: 'configuration.json'
        }
      ],
      grammars: [{ language: id, scopeName: grammar.scopeName, path: 'grammar.json' }]
    }
  })
  await writeFile(join(directory, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(directory, 'grammar.json'), JSON.stringify(grammar))
  await writeFile(
    join(directory, 'configuration.json'),
    JSON.stringify({ comments: { blockComment: ['/*', '*/'] }, brackets: [['(', ')']] })
  )
  await (kind === 'typst'
    ? cp(
        join(
          process.cwd(),
          'src/renderer/src/lib/monaco-languages/textmate-grammars/typst-LICENSE.txt'
        ),
        join(directory, 'LICENSE')
      )
    : writeFile(
        join(directory, 'LICENSE'),
        'Test fixture; authored for the Orca integration test suite.'
      ))
}
