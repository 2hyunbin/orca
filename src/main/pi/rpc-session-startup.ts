import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import type {
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import {
  AgentSessionAcquisitionRefusal,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import {
  unpickedSessionConfiguredChoice,
  withLiveCatalogListing,
  type AgentModelCatalogLiveListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { piRpcProviderLink, type PiRpcResolvedLaunch } from './rpc-launch-resolution'
import {
  applyPiRpcSessionOption,
  piModelOptionId,
  readPiRpcCommands,
  readPiRpcSessionOptions
} from './rpc-options'
import { piRpcStateSchema, type PiRpcState } from './rpc-protocol'
import type { PiRpcConnection, PiRpcSessionDeps } from './rpc-session'
import { STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS } from '../native-chat/agent-session-wire/structured-agent-session-startup-attempt-contract'

/** What the start cannot go on without waits as long as the host's startup attempt does, its only
 *  deadline; the optional reads keep their own bound and never fail the start. */
const START_REQUEST = { timeoutMs: STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS }

export class PiRpcSessionStartup {
  skipped: readonly string[] = []
  commands?: AgentSessionSlashCommand[]
  /** What the start listed; a signed-out Pi lists no model. */
  options?: AgentSessionOptionsResult

  constructor(
    private readonly input: StructuredAgentSessionAcquireInput,
    private readonly connection: PiRpcConnection,
    private readonly selected: Map<string, string>,
    private readonly deps: PiRpcSessionDeps,
    /** A new Pi session starts on its config's model; a resumed or forked one keeps its own. */
    private readonly resolvesConfig: boolean,
    private readonly setState: (state: PiRpcState) => void,
    private readonly failedCause: () => Error | undefined
  ) {}

  async run(
    launch: PiRpcResolvedLaunch,
    signal: AbortSignal
  ): Promise<StructuredAgentSessionProviderOpenResult> {
    const answer = await this.wait(this.connection.request('get_state', {}, START_REQUEST), signal)
    this.assertLive(signal)
    const state = piRpcStateSchema.parse(answer)
    if (state.model?.provider === 'unknown') {
      throw this.notSignedIn()
    }
    const link = piRpcProviderLink(
      launch,
      state.sessionFile,
      this.input.fence,
      randomUUID(),
      Date.now()
    )
    this.setState(state)
    const current: AgentSessionOptionsResult['current'] = {
      model: state.model ? piModelOptionId(state.model.provider, state.model.id) : '',
      ...(state.thinkingLevel ? { effort: state.thinkingLevel } : {})
    }
    const saved = this.input.options ?? {}
    const skipped = Object.keys(saved).filter((key) => key !== 'model' && key !== 'effort')
    // Keys a restore sent, whether or not Pi took them.
    const picked = new Set<string>()
    for (const key of ['model', 'effort'] as const) {
      const value = saved[key]
      if (value === undefined) {
        continue
      }
      picked.add(key)
      try {
        this.assertLive(signal)
        await this.wait(
          applyPiRpcSessionOption(this.connection, this.selected, key, value, START_REQUEST),
          signal
        )
        current[key] = value
      } catch (error) {
        if (!(error instanceof JsonlRpcResponseError)) {
          throw error
        }
        skipped.push(key)
        this.warn('Pi rejected a saved option', 'pi-option-restore', error, { key })
      }
    }
    this.assertLive(signal)
    current.confirmed = [...(current.model ? ['model'] : []), ...(current.effort ? ['effort'] : [])]
    // Part of the start, as other agents' handshakes answer with theirs: a Pi that lists no model
    // is signed out, and what it started on names its config's default.
    const options = await this.readListing(signal)
    this.assertLive(signal)
    if (options && options.models.length === 0) {
      throw this.notSignedIn()
    }
    // What it started on names its config's default once; a later switch teaches nothing.
    let catalogListing: AgentModelCatalogLiveListing | undefined
    if (options) {
      this.options = options
      catalogListing = withLiveCatalogListing(
        options,
        unpickedSessionConfiguredChoice({ resolvesConfig: this.resolvesConfig, picked, ...options })
      ).catalogListing
    }
    this.skipped = skipped
    await this.readCommands(signal)
    this.assertLive(signal)
    return {
      link,
      reportedOptions: options?.current ?? current,
      restoreSkippedOptions: skipped,
      ...(catalogListing ? { catalogListing } : {})
    }
  }

  /** Never fails the start: without it the chat only lacks the listing and the sign-in verdict. */
  private async readListing(signal: AbortSignal): Promise<AgentSessionOptionsResult | undefined> {
    try {
      return await this.wait(readPiRpcSessionOptions(this.connection), signal)
    } catch (error) {
      this.assertLive(signal)
      this.warn('Pi options could not be read', 'pi-options', error)
      return undefined
    }
  }

  private async readCommands(signal: AbortSignal): Promise<void> {
    try {
      this.assertLive(signal)
      const result = await this.wait(readPiRpcCommands(this.connection), signal)
      this.assertLive(signal)
      this.commands = result.commands
    } catch (error) {
      this.warn('Pi commands could not be read', 'pi-commands', error)
    }
  }

  private assertLive(signal: AbortSignal): void {
    const failure = this.failedCause()
    if (failure) {
      throw failure
    }
    if (signal.aborted || this.connection.closed) {
      throw new Error('Pi closed while starting')
    }
  }

  private wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return waitForPromiseWithSignal(promise, signal)
  }

  private notSignedIn(): AgentSessionAcquisitionRefusal {
    return withProviderDiagnostic(
      new AgentSessionAcquisitionRefusal(
        'Pi has no authenticated model provider available.',
        'notSignedIn'
      ),
      providerDiagnostic('Pi has no authenticated model provider available.', 'person')
    )
  }

  private warn(message: string, scope: string, error: unknown, fields = {}): void {
    this.deps.logger.warn(message, {
      scope,
      sessionId: this.input.identity.sessionId,
      error,
      ...fields
    })
  }
}
