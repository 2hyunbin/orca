import type { TerminalSwitchOwners } from '../../shared/terminal-switch'

type Reach = { terminalSwitches?: TerminalSwitchOwners }

/** A routing provider's owners: fresh starts go to one; any of them may hold an older start. */
export function routedTerminalSwitchOwners(
  fresh: () => Reach,
  all: () => readonly Reach[]
): TerminalSwitchOwners {
  return {
    owner: async () => (await fresh().terminalSwitches?.owner()) ?? null,
    // An owner that cannot answer is left out, so the caller reads the start as unverifiable.
    observe: async (generation, fence) =>
      (
        await Promise.all(
          all().map(
            (owner) => owner.terminalSwitches?.observe(generation, fence).catch(() => []) ?? []
          )
        )
      ).flat()
  }
}
