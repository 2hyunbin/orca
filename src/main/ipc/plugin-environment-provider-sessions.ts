import { webContents } from 'electron'
import { PluginEnvironmentProviderWindowOwners } from './plugin-environment-provider-window-owners'
import type { PluginEnvironmentProviderSender } from './plugin-environment-providers'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { prepareRuntimeEnvironmentConnectionLease } from './runtime-environment-connection-lease'
import { PluginEnvironmentProviderRuntimeClient } from '../../shared/plugins/plugin-environment-provider-runtime-client'
import {
  pluginEnvironmentProviderSessionOpenSchema,
  pluginEnvironmentProviderSessionCallSchema,
  pluginEnvironmentProviderSessionCloseSchema
} from '../../shared/plugins/plugin-environment-provider-session'
import { registerPluginRendererHandler } from './plugin-renderer-ipc'
import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'

type Session = {
  ownerKey: string
  lifetime: AbortController
  client?: PluginEnvironmentProviderRuntimeClient
  lease?: Awaited<ReturnType<typeof prepareRuntimeEnvironmentConnectionLease>>
  notify(): void
}
export class PluginEnvironmentProviderSessions {
  private readonly sessions = new Map<string, Session>()
  private readonly windows = new PluginEnvironmentProviderWindowOwners((key) => {
    for (const [id, session] of this.sessions) {
      if (session.ownerKey === key) {this.retire(id)}
    }
  })
  constructor(
    private readonly userDataPath: string,
    private readonly notify: (sender: PluginEnvironmentProviderSender, sessionId: string) => void,
    private readonly trusted: (
      sender: PluginEnvironmentProviderSender
    ) => boolean = isTrustedBrowserRenderer,
    private readonly changed?: (
      sender: PluginEnvironmentProviderSender,
      sessionId: string,
      change: PluginChangeEvent
    ) => void
  ) {}

  async open(sender: PluginEnvironmentProviderSender, raw: unknown) {
    this.requireTrusted(sender)
    const input = pluginEnvironmentProviderSessionOpenSchema.parse(raw)
    const ownerKey = this.windows.ownerKey(sender)
    if (this.sessions.has(input.sessionId)) {throw new Error('Provider review already exists')}
    if (this.sessions.size >= 64) {throw new Error('Too many provider reviews')}
    if ([...this.sessions.values()].filter((value) => value.ownerKey === ownerKey).length >= 8) {
      throw new Error('Too many provider reviews in this window')
    }
    const session: Session = {
      ownerKey,
      lifetime: new AbortController(),
      notify: () => this.notify(sender, input.sessionId)
    }
    this.sessions.set(input.sessionId, session)
    try {
      const lease = await prepareRuntimeEnvironmentConnectionLease(
        this.userDataPath,
        input,
        () => this.retire(input.sessionId, session),
        session.lifetime.signal
      )
      session.lease = lease
      session.lifetime.signal.throwIfAborted()
      session.client = new PluginEnvironmentProviderRuntimeClient(
        lease.pairing,
        input.runtimeId,
        () => this.retire(input.sessionId, session)
      )
      session.client.onChanged((change) => {
        if (session.lease?.isCurrent() && !session.lifetime.signal.aborted) {
          this.changed?.(sender, input.sessionId, change)
        } else {
          this.retire(input.sessionId, session)
        }
      })
      await session.client.observe()
      this.requireCurrent(session)
      return { sessionId: input.sessionId, runtimeId: input.runtimeId }
    } catch (error) {
      this.retire(input.sessionId, session)
      session.lease?.close()
      throw error
    }
  }
  async call(sender: PluginEnvironmentProviderSender, raw: unknown) {
    this.requireTrusted(sender)
    const input = pluginEnvironmentProviderSessionCallSchema.parse(raw)
    const session = this.owned(sender, input.sessionId)
    this.requireCurrent(session)
    if (!session.client) {throw new Error('Provider review is not ready')}
    const result = await session.client.call(input.method, input.input)
    this.requireCurrent(session)
    return result
  }
  close(sender: PluginEnvironmentProviderSender, raw: unknown): boolean {
    this.requireTrusted(sender)
    const { sessionId } = pluginEnvironmentProviderSessionCloseSchema.parse(raw)
    if (!this.sessions.has(sessionId)) {return false}
    this.owned(sender, sessionId)
    this.retire(sessionId)
    return true
  }
  private requireTrusted(sender: PluginEnvironmentProviderSender): void {
    if (sender.isDestroyed() || !this.trusted(sender))
      {throw new Error('Provider reviews require the trusted app window')}
  }
  private owned(sender: PluginEnvironmentProviderSender, id: string): Session {
    const session = this.sessions.get(id)
    if (!session || session.ownerKey !== this.windows.ownerKey(sender)) {
      throw new Error('Provider review belongs to another window or is unavailable')
    }
    return session
  }
  private requireCurrent(session: Session): void {
    if (session.lifetime.signal.aborted || !session.lease?.isCurrent()) {
      session.client?.close()
      throw new Error('The selected host or review connection changed')
    }
  }
  private retire(id: string, expected?: Session): void {
    const session = this.sessions.get(id)
    if (!session || (expected && expected !== session)) {return}
    this.sessions.delete(id)
    session.lifetime.abort()
    session.lease?.close()
    session.client?.close()
    session.notify()
  }
}

export function registerPluginEnvironmentProviderSessionHandlers(userDataPath: string): void {
  const send = (sender: PluginEnvironmentProviderSender, channel: string, input: unknown): void => {
    const current = webContents.fromId(sender.id)
    if (current === sender && !current.isDestroyed() && isTrustedBrowserRenderer(current)) {
      current.send(channel, input)
    }
  }
  const sessions = new PluginEnvironmentProviderSessions(
    userDataPath,
    (sender, sessionId) => send(sender, 'plugins:environmentProviderSessionRetired', { sessionId }),
    isTrustedBrowserRenderer,
    (sender, sessionId, change) =>
      send(sender, 'plugins:environmentProviderSessionChanged', { sessionId, change })
  )
  registerPluginRendererHandler('plugins:openEnvironmentProviderSession', (event, input: unknown) =>
    sessions.open(event.sender, input)
  )
  registerPluginRendererHandler('plugins:callEnvironmentProviderSession', (event, input: unknown) =>
    sessions.call(event.sender, input)
  )
  registerPluginRendererHandler(
    'plugins:closeEnvironmentProviderSession',
    (event, input: unknown) => sessions.close(event.sender, input)
  )
}
