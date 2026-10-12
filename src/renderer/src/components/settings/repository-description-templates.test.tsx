// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { RepositoryIssueCommandSetting } from './RepositoryIssueCommandSetting'
import { RepositoryHookCommandSourceSetting } from './RepositoryHookPolicySettings'

const prefix = 'auto.components.settings.RepositoryHooksSection.'
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()

function renderSettings(hasSharedIssueCommand: boolean): ReturnType<typeof render> {
  return render(
    <>
      <RepositoryIssueCommandSetting
        issueCommandDraft=""
        setIssueCommandDraft={() => {}}
        hasSharedIssueCommand={hasSharedIssueCommand}
        issueCommandSaveError={null}
        commitIssueCommand={async () => {}}
      />
      <RepositoryHookCommandSourceSetting
        searchQuery=""
        selectedPolicy="shared-only"
        yamlState="missing"
        yamlHooks={null}
        copiedTemplate={false}
        isAdvancedOpen
        onSelectPolicy={() => {}}
        onCopyTemplate={() => {}}
        onAdvancedOpenChange={() => {}}
      />
    </>
  )
}

afterEach(async () => {
  cleanup()
  await setRendererUiLanguage('en')
})

describe('Repository settings complete translation templates', () => {
  for (const language of ['en', 'ko'] as const) {
    it.each([false, true])(
      `preserves tokens and conditional defaults in ${language} (shared=%s)`,
      async (shared) => {
        await setRendererUiLanguage(language)
        const view = renderSettings(shared)
        const paragraphs = Array.from(view.container.querySelectorAll('p'))
        const issue = paragraphs.find(
          (p) => p.querySelector('code')?.textContent === '{{artifact_url}}'
        )
        expect(issue?.textContent).toContain('{{artifact_url}}')
        expect(issue?.textContent).not.toContain('<artifactUrl>')
        const defaultHelp = paragraphs.find(
          (p) => p.querySelector('code')?.textContent === 'orca.yaml'
        )
        if (language === 'ko') {
          expect(issue?.textContent).toContain('변수를 사용하세요.')
          expect(defaultHelp?.textContent?.includes('있는 경우')).toBe(!shared)
        } else {
          expect(defaultHelp?.textContent?.includes('when one exists')).toBe(!shared)
        }
        const sourceHelp = paragraphs.find((p) =>
          p.textContent?.includes(
            language === 'ko' ? '로컬 명령이 모두' : 'and local commands exist'
          )
        )
        expect(sourceHelp?.querySelector('code')?.textContent).toBe('orca.yaml')
      }
    )
  }

  for (const language of ['es', 'fr', 'ja', 'zh'] as const) {
    it.each([false, true])(
      `keeps previous assembled wording in ${language} (shared=%s)`,
      async (shared) => {
        await setRendererUiLanguage(language)
        const value = (key: string): string =>
          String(i18n.t(prefix + key, { artifact_url: '{{artifact_url}}' }))
        const issueText = [
          value('b997331366'),
          ' ',
          value('c85c2c88a2'),
          ' ',
          value('70ad20f883')
        ].join('')
        const defaultText = [
          value('52aef29e69'),
          ' ',
          value('39da2ae12f'),
          shared ? '.' : value('9b12f15b1e')
        ].join('')
        const sourceText = [
          value('ac9038d2cc'),
          ' ',
          value('39da2ae12f'),
          ' ',
          value('3397879bee')
        ].join('')
        const view = renderSettings(shared)
        const texts = Array.from(view.container.querySelectorAll('p')).map((p) =>
          normalize(p.textContent ?? '')
        )
        expect(texts).toContain(normalize(issueText))
        expect(texts).toContain(normalize(defaultText))
        expect(texts).toContain(normalize(sourceText))
      }
    )
  }
})
