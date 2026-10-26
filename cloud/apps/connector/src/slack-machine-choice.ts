import { CONNECTOR_AGENTS, type ConnectorHelloRequest } from '@orca-cloud/connector-contract'
import type { SlackIdentity } from './slack-identities.js'

export type KnownHost = { hostId: string; hostName: string; hello: ConnectorHelloRequest }
export type PlaceOption = { project: string; hostName: string }

export type MachineChoice =
  | { kind: 'chosen'; hostId: string; hostName: string; placeId: string; agent: string }
  // None of the person's machines runs an Orca that can take Slack work.
  | { kind: 'no_machine' }
  | { kind: 'ask'; options: PlaceOption[] }

type Place = {
  host: KnownHost & { agent: string }
  project: ConnectorHelloRequest['projects'][number]
}

function projectNames(project: Place['project']): string[] {
  const remote = project.remote?.toLowerCase()
  return [
    project.name.toLowerCase(),
    ...(remote ? [remote, remote.split('/').at(-1) ?? remote] : [])
  ]
}

// Decisions §2: project named in the message → channel default → personal default → ask. A
// project on several machines: a machine named in the message, else the default machine, else ask.
export function chooseMachine(input: {
  hosts: KnownHost[]
  identity: SlackIdentity
  channelId: string
  text: string
}): MachineChoice {
  const lower = input.text.toLowerCase()
  const words = new Set(lower.split(/[^a-z0-9._/-]+/).filter((word) => word.length > 0))
  const named = (name: string) => (/\s/.test(name) ? lower.includes(name) : words.has(name))

  const capable = input.hosts.flatMap((host) => {
    const agent = host.hello.agents.find((name) => CONNECTOR_AGENTS.some((known) => known === name))
    return agent ? [{ ...host, agent }] : []
  })
  if (capable.length === 0) {
    return { kind: 'no_machine' }
  }
  const places: Place[] = capable.flatMap((host) =>
    host.hello.projects.map((project) => ({ host, project }))
  )
  const inMessage = places.filter((place) => projectNames(place.project).some(named))
  const fallback = input.identity.channelProjects[input.channelId] ?? input.identity.defaultProject
  const matching =
    inMessage.length > 0 || fallback === null
      ? inMessage
      : places.filter((place) => projectNames(place.project).includes(fallback.toLowerCase()))

  let chosen = matching
  const onNamedHost = chosen.filter((place) => named(place.host.hostName.toLowerCase()))
  if (onNamedHost.length > 0) {
    chosen = onNamedHost
  }
  const onDefaultHost = chosen.filter((place) => place.host.hostId === input.identity.defaultHostId)
  if (onDefaultHost.length > 0) {
    chosen = onDefaultHost
  }
  const [place] = chosen
  if (chosen.length === 1 && place) {
    return {
      kind: 'chosen',
      hostId: place.host.hostId,
      hostName: place.host.hostName,
      placeId: place.project.placeId,
      agent: place.host.agent
    }
  }
  const options = (matching.length > 1 ? matching : places).map((option) => ({
    project: option.project.name,
    hostName: option.host.hostName
  }))
  return { kind: 'ask', options }
}
