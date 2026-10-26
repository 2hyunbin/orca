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
  private client: ConnectorPollClient | null = null
  // Built on connect, so the outbox file is read once and has one owner for this process.
  private events: ConnectorTurnEvents | null = null
  // The account the outbox and the running client belong to.
  private account: string | null = null

  constructor(private readonly options: ConnectorCloudOptions) {}

  /** From now on, hold the poll whenever connectors are on and an Orca account is signed in. */
  connect(): void {
    if (this.events) {
      return
    }
    this.account = this.options.account()
    if (!this.account) {
      // Turn ends left from an account that signed out while Orca was closed.
      ConnectorTurnEvents.clearStored(this.options.userDataPath)
    }
    this.events = new ConnectorTurnEvents(this.options.userDataPath)
    this.options.machine.onConnectorsToggled(() => this.reconcile())
    this.reconcile()
  }

  /** The desktop signed in, switched accounts or refreshed its sign-in. */
  accountChanged(): void {
    this.reconcile()
  }

  /** Just before the desktop signs out: stop now, and drop turn ends no other account can report. */
  signingOut(): void {
    this.client?.stop()
    this.client = null
    this.account = null
    if (this.events) {
      this.events.clear()
    } else {
      ConnectorTurnEvents.clearStored(this.options.userDataPath)
    }
  }

  private reconcile(): void {
    const { events } = this
    if (!events) {
      return
    }
    const account = this.options.account()
    const seam = this.options.machine.seam()
    const current = this.client
    if (current && (current.seam !== seam || account !== this.account)) {
      current.stop()
      this.client = null
    }
    if (account !== this.account) {
      // Pending turn ends belong to the previous account's threads; no other account can report them.
      events.clear()
      this.account = account
    }
    if (!this.client && seam && account) {
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
}
