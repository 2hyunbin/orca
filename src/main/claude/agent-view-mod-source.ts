import { CLAUDE_AGENT_VIEW_PATH } from '../../shared/claude-agent-view'
import { parseAgentHookEndpointFile } from '../../shared/agent-hook-endpoint-file'

export const CLAUDE_AGENT_VIEW_MOD_SOURCE = String.raw`
const parseEndpoint = ${parseAgentHookEndpointFile.toString()}

let identity
let configDir
let paneKey
let endedSessionId
let observedView
let viewRevision = 0

  async function post($, action, data = {}, session = identity) {
    if (!session) return {}
    let port = await $.env.get('ORCA_AGENT_HOOK_PORT')
    let token = await $.env.get('ORCA_AGENT_HOOK_TOKEN')
    const endpoint = await $.env.get('ORCA_AGENT_HOOK_ENDPOINT')
    if (endpoint) {
      try {
        const file = parseEndpoint(await $.fs.read(endpoint))
        port = file.port
        token = file.token
      } catch {}
    }
    if (!token || !/^[0-9]+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) return {}
    const response = await $.http.fetch('http://127.0.0.1:' + port + ${JSON.stringify(CLAUDE_AGENT_VIEW_PATH)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orca-agent-hook-token': token },
      body: JSON.stringify({ ...session, action, ...data })
    })
    return response.ok ? JSON.parse(response.text) : {}
  }

  async function announce($) {
    try {
      if (!paneKey || !configDir) return {}
      const sessionId = await $.session.id()
      if (sessionId === endedSessionId) return {}
      if (!identity || identity.sessionId !== sessionId) {
        identity = { paneKey, sessionId, instanceId: String(await $.clock.now()) + '-' + String(Math.random()) }
      }
      return await post($, 'register', {
        keybindings: await $.fs.read(configDir + '/keybindings.json'),
        ...(observedView?.sessionId === sessionId ? { view: observedView.view } : {})
      })
    } catch {
      try { await post($, 'end') } catch {}
      return {}
    }
  }

export function register(on) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    if (event.surface === 'terminal' && event.props.view) {
      const sessionId = await $.session.id()
      const agentId = event.props.view.agentId
      if (observedView?.sessionId !== sessionId || observedView.view.agentId !== agentId) {
        observedView = { sessionId, view: { ...(agentId ? { agentId } : {}), revision: ++viewRevision } }
        if (identity?.sessionId === sessionId) {
          try { await post($, 'observe', { view: observedView.view }) } catch {}
        }
      }
    }
    return next(event)
  })

  on('session.start', async ($, event, next) => {
    const targetPane = await $.env.get('ORCA_PANE_KEY')
    if (!event.isInteractive || event.surface !== 'terminal' || !targetPane) return next(event)
    paneKey = targetPane
    const home = await $.env.get('HOME') || await $.env.get('USERPROFILE')
    configDir = await $.env.get('CLAUDE_CONFIG_DIR') || (home ? home + '/.claude' : undefined)
    if (!configDir) return next(event)
    endedSessionId = undefined
    await $.command.register({ name: 'orca-agent-view', description: 'Open the agent selected in Orca', immediate: true })
    await announce($)
    $.clock.every(5000, () => announce($))
    return next(event)
  })

  on('command.run', { command: 'orca-agent-view' }, async ($) => {
    const session = identity
    if (!session || session.sessionId !== await $.session.id()) return {}
    const request = await post($, 'take', {}, session)
    if (!request.requestId || request.expiresAt < await $.clock.now()) return {}
    if (identity !== session || session.sessionId !== await $.session.id()) return {}
    let deny
    try {
      const result = await $.ui.view(request.agentId ? { agentId: request.agentId } : {})
      deny = result.deny
    } catch { deny = 'Claude could not switch the agent view' }
    await post($, 'ack', { requestId: request.requestId, ...(deny ? { deny } : {}) }, session)
    return {}
  })

  on('session.end', async ($, event, next) => {
    try { await post($, 'end') } catch {}
    endedSessionId = event.sessionId
    identity = undefined
    if (event.reason !== 'clear' && event.reason !== 'resume') paneKey = undefined
    return next(event)
  })
}
`.trimStart()
