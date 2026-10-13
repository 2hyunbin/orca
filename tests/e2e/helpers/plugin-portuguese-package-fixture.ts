import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginLocaleEnvelope } from '../../../src/shared/plugins/plugin-locale-envelope'
import { createPluginLocaleKit } from '../../../src/shared/plugins/plugin-locale-kit'

export async function writePluginPortuguesePackageEnvelope(directory: string): Promise<void> {
  const kit = createPluginLocaleKit(
    JSON.parse(
      await readFile(
        join(process.cwd(), 'src', 'renderer', 'src', 'i18n', 'locales', 'en.json'),
        'utf8'
      )
    )
  )
  const envelope = createPluginLocaleEnvelope({
    kit,
    locale: 'pt-BR',
    displayName: 'Português (Brasil)',
    translations: {
      'menu.file': 'Arquivo',
      'menu.settings': 'Configurações',
      'menu.edit': 'Editar',
      'settings.appearance.language.title': 'Idioma'
    }
  })
  await writeFile(join(directory, 'locales', 'pt-BR.json'), JSON.stringify(envelope))
}
