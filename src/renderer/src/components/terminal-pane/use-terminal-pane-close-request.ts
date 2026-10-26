import { useCallback, type RefObject } from 'react'
import type { TerminalPaneCloseCallbacks } from '@/constants/terminal'
import { useAppStore } from '../../store'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from '../terminal/running-terminal-close-guard'
import { probePtyRunningWork } from '../terminal/pty-running-work-probe'
import { resolveLeafCloseCopyKind } from '../terminal/terminal-close-copy-kind'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'

export function useTerminalPaneCloseRequest(
  controller: TerminalPaneBindingController,
  executeClosePane: (paneId: number, callbacks?: TerminalPaneCloseCallbacks) => void,
  cancelCloseRef: RefObject<(() => void) | undefined>,
  confirmedCloseRef: RefObject<(() => void) | null>
) {
  const { managerRef, setPendingCloseConfirmation, tabId } = controller
  const getCloseDialogCopyKind = useCallback(
    (paneId: number) => resolveLeafCloseCopyKind(tabId, managerRef.current?.getLeafId(paneId)),
    [tabId, managerRef]
  )
  const requestClose = useCallback(
    (
      paneId: number,
      ptyId: string,
      pending: { isCurrent: () => boolean } | undefined,
      callbacks?: TerminalPaneCloseCallbacks
    ) => {
      const settings = useAppStore.getState().settings
      let active = true
      let probeTimeout: ReturnType<typeof setTimeout> | undefined
      const cancel = () => {
        if (!active) {
          return
        }
        active = false
        clearTimeout(probeTimeout)
        callbacks?.signal?.removeEventListener('abort', cancel)
        cancelCloseRef.current = undefined
        confirmedCloseRef.current = null
        setPendingCloseConfirmation(null)
        callbacks?.onCancel?.()
      }
      cancelCloseRef.current = cancel
      callbacks?.signal?.addEventListener('abort', cancel, { once: true })
      const close = (): void => {
        if (!active) {
          return
        }
        active = false
        callbacks?.signal?.removeEventListener('abort', cancel)
        cancelCloseRef.current = undefined
        if ((!pending || pending.isCurrent()) && callbacks?.isCurrent?.() !== false) {
          executeClosePane(paneId, callbacks)
        } else {
          callbacks?.onCancel?.()
        }
      }
      let decided = false
      const decide = (act: () => void): void => {
        if (decided || !active) {
          return
        }
        decided = true
        act()
      }
      const confirmClose = (): void => {
        if ((pending && !pending.isCurrent()) || callbacks?.isCurrent?.() === false) {
          cancel()
          return
        }
        confirmedCloseRef.current = close
        setPendingCloseConfirmation({
          paneId,
          copyKind: getCloseDialogCopyKind(paneId)
        })
      }
      probeTimeout = setTimeout(
        () =>
          decide(
            pending && settings?.skipCloseTerminalWithRunningProcessConfirm ? close : confirmClose
          ),
        RUNNING_CLOSE_PROBE_TIMEOUT_MS
      )
      // Reuse tab-close admission so unanswered-host behavior cannot drift between split and tab closes.
      void probePtyRunningWork([ptyId], { timeoutMs: RUNNING_CLOSE_PROBE_TIMEOUT_MS })
        .then((probes) => {
          clearTimeout(probeTimeout)
          decide(() => {
            if (
              (pending ? probes[0]?.verdict === 'exited' : probes[0]?.verdict !== 'live') ||
              settings?.skipCloseTerminalWithRunningProcessConfirm
            ) {
              close()
            } else {
              confirmClose()
            }
          })
        })
        .catch(() => {
          clearTimeout(probeTimeout)
          decide(
            pending && !settings?.skipCloseTerminalWithRunningProcessConfirm ? confirmClose : close
          )
        })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the owning hook's pre-split dependency contract.
    [executeClosePane, getCloseDialogCopyKind]
  )

  return { requestClose, getCloseDialogCopyKind }
}
