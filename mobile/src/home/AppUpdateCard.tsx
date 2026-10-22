import { ArrowUpFromLine, X } from 'lucide-react-native'
import { IconButton } from '../components/ui/IconButton'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { colors } from '../theme/mobile-theme'

/** Home's update notice: one row in its own inset group, with a dismiss button beside it. */
export function AppUpdateCard(props: {
  version: string
  onPress: () => void
  onDismiss: () => void
}) {
  const title = `Orca ${props.version} is available`
  return (
    <ListGroup separatorInset={LIST_LEADING_INSET}>
      <ListRow
        title={title}
        subtitle="Tap to update"
        leading={<ArrowUpFromLine size={20} color={colors.textPrimary} strokeWidth={2} />}
        onPress={props.onPress}
        accessibilityLabel={`${title}, tap to update`}
        accessory={
          <IconButton
            icon={X}
            variant="bare"
            iconSize={16}
            iconColor={colors.textSecondary}
            accessibilityLabel={`Dismiss Orca ${props.version} update`}
            onPress={props.onDismiss}
          />
        }
      />
    </ListGroup>
  )
}
