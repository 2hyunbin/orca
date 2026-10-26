// This desktop's link to the Orca Cloud connector, as whichever Orca account it is signed in to.
import { ConnectorPollClient } from './connector-poll-client'
import type { ConnectorMachine } from './connector-machine'
import { ConnectorAccountTransport, type ConnectorTokenMint } from './connector-transport'
import { ConnectorTurnEvents } from './connector-turn-events'

export type ConnectorCloudOptions = {
  userDataPath: string
  origin: string
  machine: ConnectorMachine
  /** The signed-in Orca account, or null while signed out. */
  account: () => string | null
  /** Mints connector tokens for one account and no other. */
  mintFor: (account: string) => ConnectorTokenMint
  fetchImpl?: typeof globalThis.fetch
}

export class ConnectorCloud {
  private connected = false
  private client: ConnectorPollClient | null = null
  // The signed-in account's outbox: one owner per process, replaced only when another account signs in.
  private events: ConnectorTurnEvents | null = null
  // From sign-out until the next sign-in, so nothing restarts while the old session is still readable.
  private suspended = false

  constructor(private readonly options: ConnectorCloudOptions) {}

  /** From now on, hold the poll whenever connectors are on and an Orca account is signed in. */
  connect(): void {
    if (this.connected) {
      return
    }
    this.connected = true
    this.options.machine.onConnectorsToggled(() => this.reconcile())
    this.reconcile()
  }

  /** The desktop signed in, switched accounts or refreshed its sign-in. */
  accountChanged(): void {
    this.suspended = false
    this.reconcile()
  }

  /** Just before the desktop signs out: stop now, and drop turn ends no other account can report. */
  signingOut(): void {
    this.suspended = true
    this.stopClient()
    if (this.events) {
      this.events.clear()
      this.events = null
    } else {
      ConnectorTurnEvents.clearStored(this.options.userDataPath)
    }
  }

  private reconcile(): void {
    if (!this.connected) {
      return
    }
    const account = this.suspended ? null : this.options.account()
    const seam = this.options.machine.seam()
    if (account && this.events?.account !== account) {
      this.stopClient()
      // Pending turn ends belong to the previous account's threads; no other account may report them.
      this.events?.clear()
      this.events = new ConnectorTurnEvents(this.options.userDataPath, account)
    }
    if (this.client && (this.client.seam !== seam || !account)) {
      this.stopClient()
    }
    const { events } = this
    if (!this.client && seam && account && events) {
      this.client = new ConnectorPollClient({
        transport: new ConnectorAccountTransport(
          this.options.origin,
          this.options.mintFor(account),
          this.options.fetchImpl
        ),
        events,
        seam,
        machine: this.options.machine
      })
      this.client.start()
    }
  }

  private stopClient(): void {
    this.client?.stop()
    this.client = null
  }
}
