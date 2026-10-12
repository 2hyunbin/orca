// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { TooltipProvider } from '../ui/tooltip'
import { GitPane } from './GitPane'
import { AutoRenameBranchFromWorkSetting } from './AutoRenameBranchFromWorkSetting'

const settings = getDefaultSettings('/translation-audit')
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()

afterEach(async () => {
  cleanup()
  await setRendererUiLanguage('en')
})

describe('Git settings complete translation templates', () => {
  it.each(['en', 'ko'] as const)(
    'keeps code tokens and the prompt popover in %s',
    async (language) => {
      await setRendererUiLanguage(language)
      const git = render(
        <TooltipProvider>
          <GitPane
            settings={settings}
            updateSettings={() => {}}
            writeSourceControlAiSettings={async () => {}}
            displayedGitUsername="audit"
          />
        </TooltipProvider>
      )
      const paragraph = Array.from(git.container.querySelectorAll('p')).find((p) =>
        p.textContent?.includes('git diff main...HEAD')
      )
      expect(
        Array.from(paragraph?.querySelectorAll('code') ?? []).map((code) => code.textContent)
      ).toEqual(['main', 'master', 'git diff main...HEAD'])
      expect(paragraph?.textContent).not.toContain('<mainBranch>')
      if (language === 'ko') {
        expect(paragraph?.textContent).toContain(
          '로컬에만 있는 커밋이 있으면 업데이트를 건너뜁니다.'
        )
      }
      cleanup()
      const prompt = render(
        <AutoRenameBranchFromWorkSetting
          settings={settings}
          updateSettings={() => {}}
          writeSourceControlAiSettings={async () => {}}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: language === 'ko' ? '고급' : 'Advanced' }))
      expect(
        Array.from(prompt.container.querySelectorAll('p code')).map((code) => code.textContent)
      ).toEqual([
        'Nautilus',
        '{basePrompt}',
        '{firstPrompt}',
        '{assistantMessage}',
        'fix-login-flow'
      ])
      fireEvent.click(
        screen.getByRole('button', {
          name: language === 'ko' ? '내장 브랜치 이름 프롬프트' : 'built-in branch-name prompt'
        })
      )
      await waitFor(() =>
        expect(document.querySelector('[data-slot="popover-content"] pre')?.textContent).toContain(
          'first agent prompt'
        )
      )
    }
  )

  it.each(['es', 'fr', 'ja', 'zh'] as const)(
    'preserves the previous assembled wording in %s',
    async (language) => {
      await setRendererUiLanguage(language)
      const prefix = 'auto.components.settings.GitPane.'
      const value = (key: string): string => String(i18n.t(prefix + key))
      const oldText = [
        value('976afc6b3e'),
        ' ',
        value('ffba483bae'),
        ' ',
        value('5bf885be48'),
        ' ',
        value('3ae3de8898'),
        value('db3a127eb1'),
        ' ',
        value('d072a12995'),
        ' ',
        value('36e3de3619')
      ].join('')
      const view = render(
        <TooltipProvider>
          <GitPane
            settings={settings}
            updateSettings={() => {}}
            writeSourceControlAiSettings={async () => {}}
            displayedGitUsername="audit"
          />
        </TooltipProvider>
      )
      const paragraph = Array.from(view.container.querySelectorAll('p')).find((p) =>
        p.textContent?.includes('git diff main...HEAD')
      )
      expect(normalize(paragraph?.textContent ?? '')).toBe(normalize(oldText))
      const rich = String(i18n.t(`${prefix}refreshLocalBaseDescription`))
      expect(rich).toContain('<mainBranch>main</mainBranch>')
      cleanup()
      const advancedPrefix = 'auto.components.settings.AutoRenameBranchFromWorkSetting.'
      const previous = (key: string): string => String(i18n.t(advancedPrefix + key))
      const oldGuide = [
        previous('9241b59bf5'),
        ' ',
        previous('c71770c455'),
        ' ',
        previous('69bf4830c2'),
        ' ',
        previous('9c9b54e4ea'),
        previous('56580dcf60'),
        ' ',
        previous('2ee2779c05'),
        ' ',
        previous('570817d126'),
        ' ',
        previous('a4fa380b67'),
        previous('5d569f5199'),
        ' ',
        previous('800edb1e54'),
        previous('f19a56498d')
      ].join('')
      const prompt = render(
        <AutoRenameBranchFromWorkSetting
          settings={settings}
          updateSettings={() => {}}
          writeSourceControlAiSettings={async () => {}}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: previous('e784ea62dc') }))
      const guide = Array.from(prompt.container.querySelectorAll('p')).find((p) =>
        p.textContent?.includes('{assistantMessage}')
      )
      expect(normalize(guide?.textContent ?? '')).toBe(normalize(oldGuide))
    }
  )
})
