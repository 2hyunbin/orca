import type { SqlRow } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_AGENTS,
  ConnectorHelloRequestSchema,
  type ConnectorHelloRequest
} from '@orca-cloud/connector-contract'
import type { SlackIdentity } from './slack-identities.js'

export type KnownHost = { hostId: string; hostName: string; hello: ConnectorHelloRequest }
// A connector_hosts row with its latest hello; null when the stored hello no longer parses.
export function knownHost(row: SqlRow): KnownHost | null {
  const hello = ConnectorHelloRequestSchema.safeParse(JSON.parse(String(row.hello)))
  return hello.success
    ? { hostId: String(row.host_id), hostName: String(row.host_name), hello: hello.data }
    : null
}

export type PlaceOption = { project: string; hostName: string }

export type MachineChoice =
  | { kind: 'chosen'; hostId: string; hostName: string; placeId: string; agent: string }
  // None of the person's machines runs an Orca that can take Slack work.
  | { kind: 'no_machine' }
  | { kind: 'ask'; options: PlaceOption[] }

type Project = ConnectorHelloRequest['projects'][number]
type Place = { host: KnownHost & { agent: string }; project: Project }

// One project across machines: its remote when it has one, else its name.
function projectKey(project: Project): string {
  return (project.remote ?? project.name).toLowerCase()
}

function projectNames(project: Project): string[] {
  const remote = project.remote?.toLowerCase()
  return [
    project.name.toLowerCase(),
    ...(remote ? [remote, remote.split('/').at(-1) ?? remote] : [])
  ]
}

// Words of the message, plus owner/name for each repository link (<https://host/owner/name…>).
function messageWords(lower: string): Set<string> {
  const words = lower.split(/[^a-z0-9._/-]+/).filter((word) => word.length > 0)
  const links = [
    ...lower.matchAll(/https?:\/\/[^/\s|>]+\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[/|>#?\s]|$)/g)
  ]
  return new Set([...words, ...links.map((match) => match[1] ?? '')])
}

// Decisions §2. The project first: named in the message → channel default → personal default; more
// than one → ask. Then, among that project's machines: named in the message → default → ask.
export function chooseMachine(input: {
  hosts: KnownHost[]
  identity: SlackIdentity
  channelId: string
  text: string
}): MachineChoice {
  const lower = input.text.toLowerCase()
  const words = messageWords(lower)
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
  const fallback = input.identity.channelProjects[input.channelId] ?? input.identity.defaultProject
  const inMessage = places.filter((place) => projectNames(place.project).some(named))
  const referenced =
    inMessage.length > 0 || fallback === null
      ? inMessage
      : places.filter((place) => projectNames(place.project).includes(fallback.toLowerCase()))
  if (new Set(referenced.map((place) => projectKey(place.project))).size !== 1) {
    return ask(referenced.length > 0 ? referenced : places)
  }

  let machines = referenced
  for (const prefer of [
    (place: Place) => named(place.host.hostName.toLowerCase()),
    (place: Place) => place.host.hostId === input.identity.defaultHostId
  ]) {
    const preferred = machines.filter(prefer)
    if (preferred.length > 0) {
      machines = preferred
    }
  }
  const [place] = machines
  if (machines.length !== 1 || !place) {
    return ask(machines)
  }
  return {
    kind: 'chosen',
    hostId: place.host.hostId,
    hostName: place.host.hostName,
    placeId: place.project.placeId,
    agent: place.host.agent
  }
}

function ask(places: Place[]): MachineChoice {
  return {
    kind: 'ask',
    options: places.map((place) => ({ project: place.project.name, hostName: place.host.hostName }))
  }
}
