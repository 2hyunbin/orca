import { SquareTerminal } from 'lucide-react-native'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { colors } from '../theme/mobile-theme'
import { useHostDisplay, type HostDisplaySource } from '../transport/use-host-display'
import type { HomeResumeCard } from '../worktree/home-resume-card'

/** The likeliest next step, first on Home: the workspace to go back to and the desktop it is on. */
export function MobileHomeResumeCard(props: {
  card: HomeResumeCard
  /** The desktop `card.hostId` names, so the row can call it what its Home row does. */
  desktop: HostDisplaySource | null
  onOpen: (card: HomeResumeCard) => void
}) {
  const { worktree, actionable } = props.card
  const display = useHostDisplay(props.desktop)
  const desktopName = props.desktop ? display.title : 'your desktop'
  const title = worktree.displayName || worktree.repo
  const where = [worktree.repo, worktree.branch, desktopName]
    .filter((part) => part && part !== title)
    .join(' · ')
  return (
    <>
      <SectionHeader title="Resume" />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        <ListRow
          title={title}
          subtitle={actionable ? where : `Connect ${desktopName} to resume.`}
          leading={<SquareTerminal size={20} color={colors.textSecondary} strokeWidth={2} />}
          navigates
          disabled={!actionable}
          onPress={() => props.onOpen(props.card)}
          accessibilityLabel={`Resume ${title}${actionable ? `, ${where}` : `. Connect ${desktopName} to resume.`}`}
        />
      </ListGroup>
    </>
  )
}
