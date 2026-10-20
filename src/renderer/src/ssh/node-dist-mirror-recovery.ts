/** Opening, saving and retrying the Node.js mirror recovery for an SSH host's failed setup. */
import {
  normalizeNodeDistMirrorUrl,
  type NodeDistMirrorRefusal
} from '../../../shared/node-dist-mirror'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { trackSshConnect } from './ssh-connect-in-flight'

export const NODE_DIST_MIRROR_SUGGESTION = 'https://npmmirror.com/mirrors/node/'

/** Where "Open mirror setting" lands; the Network section always renders, its fields may not. */
export const NODE_DIST_MIRROR_SETTINGS_SECTION_ID = 'settings-network'

export function openNodeDistMirrorDialog(targetId: string): void {
  useAppStore.getState().openModal('node-dist-mirror', { targetId })
}

export function readNodeDistMirrorDialogTarget(data: Record<string, unknown>): string | null {
  return typeof data.targetId === 'string' && data.targetId ? data.targetId : null
}

export function openNodeDistMirrorSettings(): void {
  const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({
    pane: 'advanced',
    repoId: null,
    sectionId: NODE_DIST_MIRROR_SETTINGS_SECTION_ID
  })
}

export type SaveNodeDistMirrorResult =
  | { outcome: 'retrying'; retry: Promise<unknown> }
  | { outcome: 'refused'; reason: NodeDistMirrorRefusal }
  | { outcome: 'save-failed'; message: string }

const defaultDeps = {
  save: (nodeDistMirrorUrl: string) =>
    useAppStore.getState().updateSettingsOrThrow({ nodeDistMirrorUrl }),
  connect: (targetId: string) => window.api.ssh.connect({ targetId })
}

/**
 * Saves through the same setting and IPC as Settings > Advanced > Network, then connects again.
 * Why save first: main reads the setting when the connect downloads Node.
 */
export async function saveNodeDistMirrorAndRetry(
  targetId: string,
  text: string,
  deps: {
    save: (nodeDistMirrorUrl: string) => Promise<void>
    connect: (targetId: string) => Promise<unknown>
  } = defaultDeps
): Promise<SaveNodeDistMirrorResult> {
  const normalized = normalizeNodeDistMirrorUrl(text)
  if (!normalized.ok) {
    return { outcome: 'refused', reason: normalized.reason }
  }
  // Why: an empty field would clear the setting, which is no mirror at all.
  if (!normalized.value) {
    return { outcome: 'refused', reason: 'invalid' }
  }
  try {
    await deps.save(normalized.value)
  } catch (error) {
    return {
      outcome: 'save-failed',
      message:
        error instanceof Error && error.message
          ? error.message
          : translate(
              'auto.components.settings.nodeDistMirrorDialog.saveFailed',
              'Orca couldn’t save the mirror.'
            )
    }
  }
  return { outcome: 'retrying', retry: trackSshConnect(targetId, deps.connect(targetId)) }
}
