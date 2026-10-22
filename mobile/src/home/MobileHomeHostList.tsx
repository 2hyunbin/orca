import { memo, useCallback, type ReactElement } from 'react'
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { MobileHostCard } from '../components/MobileHostCard'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { SectionHeader } from '../components/ui/SectionHeader'
import type { HomeStatsSummary } from '../stats/home-stats-total'
import { spacing } from '../theme/mobile-theme'
import { classifyConnection } from '../transport/connection-health'
import { resolveHomeHostConnectionState } from '../transport/home-host-auto-connect'
import { useHostStatusGates } from '../transport/host-status-gates'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostCatalogEntry } from '../transport/types'
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'
import type { HomeHostConnections } from './home-host-connection-projection'
import { MobileHomeListHeader } from './MobileHomeListHeader'

type MobileHomeHostListProps = {
  autoConnectHostIds: string[]
  bottomInset: number
  contentMaxWidth: number
  /** Drawn between the stats and the desktops: the Resume row, when there is one. */
  resume: ReactElement | null
  footer: ReactElement
  hostAttempts: Record<string, number>
  hostClients: Readonly<Record<string, RpcClient>>
  hostLastConnected: Record<string, number | null>
  hostConnections: HomeHostConnections
  hosts: HostCatalogEntry[]
  hostStates: Record<string, ConnectionState>
  isWideLayout: boolean
  stats: HomeStatsSummary | null
  worktreeInfo: Record<string, HostWorktreeInfo>
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  onOpen: (host: HostCatalogEntry) => void
  onLongPress: (host: HostCatalogEntry) => void
  onOpenActions: (host: HostCatalogEntry) => void
}

/** Home's scrolling body: large title, Resume, one "Desktops" group, then the footer. */
export function MobileHomeHostList(props: MobileHomeHostListProps) {
  return (
    <ScrollView
      onScroll={props.onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={[
        { paddingBottom: spacing.xl + props.bottomInset },
        props.isWideLayout && {
          maxWidth: props.contentMaxWidth,
          width: '100%',
          alignSelf: 'center'
        }
      ]}
    >
      <MobileHomeListHeader stats={props.stats} />
      {props.resume}
      <SectionHeader
        title="Desktops"
        count={props.hosts.length > 1 ? props.hosts.length : undefined}
      />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {props.hosts.map((item) => (
          <MobileHomeHostRow
            key={item.id}
            item={item}
            autoConnectHostIds={props.autoConnectHostIds}
            client={props.hostClients[item.id] ?? null}
            hostAttempts={props.hostAttempts}
            hostLastConnected={props.hostLastConnected}
            hostConnections={props.hostConnections}
            hostStates={props.hostStates}
            worktreeInfo={props.worktreeInfo}
            onOpen={props.onOpen}
            onLongPress={props.onLongPress}
            onOpenActions={props.onOpenActions}
          />
        ))}
      </ListGroup>
      {props.footer}
    </ScrollView>
  )
}

type MobileHomeHostRowProps = Pick<
  MobileHomeHostListProps,
  | 'autoConnectHostIds'
  | 'hostAttempts'
  | 'hostLastConnected'
  | 'hostConnections'
  | 'hostStates'
  | 'worktreeInfo'
  | 'onOpen'
  | 'onLongPress'
  | 'onOpenActions'
> & { item: HostCatalogEntry; client: RpcClient | null }

const MobileHomeHostRow = memo(function MobileHomeHostRow(props: MobileHomeHostRowProps) {
  const { item, onLongPress, onOpen, onOpenActions } = props
  const state = resolveHomeHostConnectionState(
    item.id,
    props.hostStates[item.id],
    props.autoConnectHostIds
  )
  // Why: the same status read the host screen's gate makes, so a desktop that would show the
  // update wall says "Update needed" here instead of "Connected".
  const { compatVerdict } = useHostStatusGates({
    hostId: item.id,
    client: props.client,
    connState: state
  })
  const connection = props.hostConnections[item.id]
  const verdict = classifyConnection({
    state,
    reconnectAttempts: props.hostAttempts[item.id] ?? 0,
    lastConnectedAt: props.hostLastConnected[item.id] ?? null,
    endpoint: item.endpoint,
    pendingPath: connection?.pendingPath ?? null,
    pairingRejected: connection?.pairingRejected ?? false,
    relayHostReachability: connection?.relayHostReachability ?? 'connecting',
    hostName: item.name
  })
  const open = useCallback(() => onOpen(item), [item, onOpen])
  const longPress = useCallback(() => onLongPress(item), [item, onLongPress])
  const openActions = useCallback(() => onOpenActions(item), [item, onOpenActions])

  return (
    <MobileHostCard
      host={item}
      credentialStatus={item.credentialStatus}
      state={state}
      verdict={verdict}
      path={connection?.path ?? 'lan'}
      worktreeInfo={props.worktreeInfo[item.id]}
      compatVerdict={compatVerdict}
      onPress={open}
      onLongPress={longPress}
      onOpenActions={openActions}
    />
  )
})
