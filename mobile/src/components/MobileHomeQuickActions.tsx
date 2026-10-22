import type { ReactNode } from 'react'
import { Plus, QrCode } from 'lucide-react-native'
import type { HostProfile } from '../transport/types'
import { colors } from '../theme/mobile-theme'
import { ListGroup, LIST_LEADING_INSET } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SectionHeader } from './ui/SectionHeader'

type Props = {
  connectedHosts: HostProfile[]
  onPairDesktop: () => void
  onCreateWorkspace: () => void
  /** Rows drawn first in the same group, e.g. Tasks. */
  children?: ReactNode
}

/** Home's "Actions" group: what to do next, each a row with an icon and a chevron. */
export function MobileHomeQuickActions(props: Props) {
  const canCreateWorkspace = props.connectedHosts.length > 0
  return (
    <>
      <SectionHeader title="Actions" />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {props.children}
        <ListRow
          title="New workspace"
          subtitle={canCreateWorkspace ? undefined : 'Connect a desktop first.'}
          leading={<Plus size={20} color={colors.textSecondary} strokeWidth={2} />}
          navigates
          disabled={!canCreateWorkspace}
          onPress={props.onCreateWorkspace}
          accessibilityLabel={
            canCreateWorkspace ? 'New workspace' : 'New workspace, connect a desktop first'
          }
        />
        <ListRow
          title="Pair desktop"
          leading={<QrCode size={20} color={colors.textSecondary} strokeWidth={2} />}
          navigates
          onPress={props.onPairDesktop}
        />
      </ListGroup>
    </>
  )
}
