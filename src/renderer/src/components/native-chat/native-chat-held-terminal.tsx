import { useRef, useState } from 'react'
import { Trans } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { i18n, translate } from '@/i18n/i18n'
import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { resolveOriginalPaneTarget } from '../right-sidebar/ai-vault-original-pane'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { structuredAgentSessionOwnerForTab } from '@/runtime/structured-agent-session-owner'
import type { AgentSessionHoldingTerminal } from '../../../../shared/agent-session-holding-terminal'
import type { TerminalPaneRevealTarget } from '../../../../shared/terminal-pane-reveal'
import {
  HELD_TERMINAL_CONTINUE_SENTENCE,
  HELD_TERMINAL_OPEN_SENTENCE
} from '../../../../shared/agent-session-failure-copy'
import { closeHoldingTerminalThenContinue } from './close-holding-terminal'
export type HeldTerminalTarget = TerminalPaneRevealTarget & {
  executionHostId: ExecutionHostId
  title: string
}

export function resolveHeldTerminalTarget(
  state: AppState,
  terminal: AgentSessionHoldingTerminal | undefined,
  executionHostId: ExecutionHostId
): HeldTerminalTarget | null {
  const host = parseExecutionHostId(executionHostId)
  const pane = terminal && parsePaneKey(terminal.paneKey)
  if (!terminal || !pane || !host || hasWorktreeSleepIntent(terminal.worktreeId)) {
    return null
  }
  const tabId = host.kind === 'runtime' ? toWebTerminalSurfaceTabId(pane.tabId) : pane.tabId
  const target = resolveOriginalPaneTarget({
    state,
    paneKey: makePaneKey(tabId, pane.leafId),
    worktreeIdHint: terminal.worktreeId
  })
  if (!target || target.worktreeId !== terminal.worktreeId) {
    return null
  }
  const unified = state.unifiedTabsByWorktree[target.worktreeId]?.find(
    (t) => t.contentType === 'terminal' && (t.entityId === tabId || t.id === tabId)
  )
  if (
    structuredAgentSessionOwnerForTab(state, unified ?? { worktreeId: target.worktreeId }) !==
    executionHostId
  ) {
    return null
  }
  const tab = state.tabsByWorktree[target.worktreeId]?.find((t) => t.id === tabId)
  if (!tab) {
    return null
  }
  return {
    ...target,
    executionHostId,
    title: resolveTerminalTabTitle(tab, state.settings?.tabAutoGenerateTitle === true, 'Terminal')
  }
}
export const closeHoldingTerminalLabel = () =>
  translate('components.native-chat.heldTerminal.close', 'Close terminal')

export function HeldTerminalSentence({
  target,
  agent,
  inChat = true
}: {
  target: HeldTerminalTarget
  agent: string
  inChat?: boolean
}): React.JSX.Element {
  return (
    <Trans
      i18n={i18n}
      defaults={
        inChat
          ? translate(
              'components.native-chat.heldTerminal.continue',
              HELD_TERMINAL_CONTINUE_SENTENCE
            )
          : translate('components.native-chat.heldTerminal.open', HELD_TERMINAL_OPEN_SENTENCE)
      }
      values={{ agent, terminal: target.title }}
      components={{
        terminal: (
          <a
            href="#terminal"
            className="text-chat-foreground underline underline-offset-2 hover:text-chat-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault()
              revealTerminalPane(target)
            }}
          />
        )
      }}
    />
  )
}
export function useHeldTerminalNotice(
  terminal: AgentSessionHoldingTerminal | undefined,
  executionHostId: ExecutionHostId | undefined,
  agent: string,
  onContinue: (() => void | Promise<void>) | null,
  inChat = true
) {
  const target = useAppStore(
    useShallow((state) =>
      executionHostId ? resolveHeldTerminalTarget(state, terminal, executionHostId) : null
    )
  )
  const busy = useRef(false)
  const [closing, setClosing] = useState(false)
  return target
    ? {
        content: <HeldTerminalSentence target={target} agent={agent} inChat={inChat} />,
        action: onContinue
          ? {
              label: closeHoldingTerminalLabel(),
              disabled: closing,
              onClick: () => {
                if (busy.current) {
                  return
                }
                busy.current = true
                setClosing(true)
                void closeHoldingTerminalThenContinue(target, onContinue).finally(() => {
                  busy.current = false
                  setClosing(false)
                })
              }
            }
          : undefined
      }
    : null
}

export function toastHeldTerminal(input: {
  terminal?: AgentSessionHoldingTerminal
  executionHostId: ExecutionHostId
  agent: string
  fallback: string
  onContinue: () => void | Promise<void>
}): void {
  const target = resolveHeldTerminalTarget(
    useAppStore.getState(),
    input.terminal,
    input.executionHostId
  )
  if (!target) {
    toast.error(input.fallback)
    return
  }
  let busy = false
  const id = toast.error(
    <HeldTerminalSentence target={target} agent={input.agent} inChat={false} />,
    {
      action: {
        label: closeHoldingTerminalLabel(),
        onClick: (event) => {
          event.preventDefault()
          if (busy) {
            return
          }
          busy = true
          const button = event.currentTarget
          if (button instanceof HTMLButtonElement) {
            button.disabled = true
          }
          void closeHoldingTerminalThenContinue(target, input.onContinue)
            .then((continued) => {
              if (continued) {
                toast.dismiss(id)
              }
            })
            .finally(() => {
              busy = false
              if (button instanceof HTMLButtonElement) {
                button.disabled = false
              }
            })
        }
      }
    }
  )
}
