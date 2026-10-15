import { StyleSheet } from 'react-native'
import { MIN_TOUCH_TARGET, colors, radii, spacing, typography } from '../theme/mobile-theme'

export const hostScreenPrimaryStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.sm
  },
  backButton: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sidebarCollapseButton: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    marginLeft: spacing.xs
  },
  hostIdentity: {
    flex: 1,
    minWidth: 0,
    marginRight: spacing.md
  },
  hostIdentityLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  hostPlatformText: {
    marginLeft: 16,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16
  },
  hostNameText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  reconnectButton: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  reconnectButtonText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  // 48pt row so the 32pt chips' vertical slop stays inside it (Android drops touches outside the parent).
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  embeddedToolbar: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  embeddedToolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  embeddedFilterChip: {
    flex: 1,
    minWidth: 0,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 0
  },
  embeddedModeButton: {
    flex: 1,
    minWidth: 0,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 0
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  filterChipActive: {
    borderColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  filterChipText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  filterChipTextActive: {
    color: colors.textPrimary
  },
  toolbarChip: {
    height: 32,
    paddingVertical: 0,
    paddingHorizontal: spacing.md,
    borderRadius: 16
  },
  toolbarModeButton: {
    height: 32,
    paddingVertical: 0
  },
  toolbarChipText: {
    fontSize: 13
  },
  modeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sortLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 12,
    color: colors.textSecondary
  },
  toolbarSpacer: {
    flex: 1
  },
  floatingWorkspaceHeaderButton: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  embeddedToolbarIconButton: {
    flex: 1,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  toolbarIconDisabled: {
    opacity: 0.6
  },
  toolbarIconButton: {
    width: 40,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  searchBar: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  }
})
