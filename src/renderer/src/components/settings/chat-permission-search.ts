import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getChatPermissionSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-permissions',
  title: translate('settings.chat.permissionsTitle', 'Permissions for new chats'),
  // Temporary until chats can run an agent's own settings.
  description: translate(
    'settings.chat.permissionsDescriptionOwnAgents',
    'New chats of agents set to their own settings in Settings → Agents. Other agents start chats in their permission there.'
  )
}))
