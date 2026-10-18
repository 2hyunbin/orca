import { useContext, useRef } from 'react'
import { View, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, Folder, GitBranch, MoreHorizontal, PanelLeftOpen } from 'lucide-react-native'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { WorkspaceServerContext } from '../transport/use-workspace-client'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionHeader({ controller }: { controller: MobileSessionController }) {
  const {
    hostId,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    connState,
    forceReconnectHost,
    worktreeName,
    worktreePath,
    worktreeHostId,
    hostName,
    activePanel,
    setShowHeaderMoreActions,
    requestLeaveSession,
    visibleTabs,
    showConnectionRetry,
    terminalSummary,
    handlePanelTap,
    showHeaderMoreButton
  } = controller
  const revealSidebar = useHostSidebarReveal()
  const topBarRef = useRef<View>(null)
  const server = useContext(WorkspaceServerContext)
  // Only a proven local record belongs to this route's desktop or server.
  const detailHostName = worktreeHostId === 'local' ? (server ? server.name : hostName) : null
  // Why: a sideways phone is ~390pt tall, so the tabs share the top bar instead of taking a second row.
  const hasTabs = visibleTabs.length > 0
  const tabsInTopBar = useResponsiveLayout().isLandscapePhone && hasTabs
  const tabStrip = hasTabs ? (
    <MobileSessionTabStrip controller={controller} inTopBar={tabsInTopBar} />
  ) : null
  return (
    <SafeAreaView style={styles.sessionChrome} edges={['top']}>
      <View ref={topBarRef} style={styles.sessionTopBar}>
        {revealSidebar ? (
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={revealSidebar}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Show sidebar"
          >
            <PanelLeftOpen size={18} color={colors.textSecondary} />
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={requestLeaveSession}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to worktrees"
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>

        <MobileSessionTitleBlock
          title={worktreeName || 'Terminal'}
          path={worktreePath}
          hostName={detailHostName ?? null}
          connState={connState}
          besideTabs={tabsInTopBar}
          barRef={topBarRef}
          meta={terminalSummary}
          showConnectionRetry={showConnectionRetry}
          onRetry={() => {
            if (hostId && forceReconnectHost) {
              void forceReconnectHost(hostId)
            }
          }}
        />
        {tabsInTopBar ? tabStrip : null}
        {!isFloatingWorkspaceRoute && (
          <MobileSessionHeaderIconButton
            active={activePanel === 'files'}
            accessibilityLabel="Open file explorer"
            icon={Folder}
            onPress={() => handlePanelTap('files')}
          />
        )}
        {!isFolderWorkspaceRoute && !isFloatingWorkspaceRoute && (
          <MobileSessionHeaderIconButton
            active={activePanel === 'sourceControl'}
            accessibilityLabel="Open source control"
            icon={GitBranch}
            onPress={() => handlePanelTap('sourceControl')}
          />
        )}
        {showHeaderMoreButton ? (
          <MobileSessionHeaderIconButton
            active={activePanel === 'pr'}
            accessibilityLabel="More session actions"
            icon={MoreHorizontal}
            onPress={() => setShowHeaderMoreActions(true)}
          />
        ) : null}
      </View>

      {tabsInTopBar ? null : tabStrip}
    </SafeAreaView>
  )
}
