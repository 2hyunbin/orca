/**
 * R38: whether a finished move's distro is still the one it moved into. A rename keeps the GUID,
 * so it is the same distro; a re-register under the old name gets a new GUID, and its fresh host
 * has none of the moved state.
 */
import type { WslDistroRegistration } from '../../wsl/wsl-distro-registry-id'
import type { WslMovedDistroVerdict } from './wsl-move-orchestrator-transitions'

export function wslMovedDistroVerdict(
  registrations: readonly WslDistroRegistration[] | null,
  distro: string,
  distroGuid: string | undefined
): WslMovedDistroVerdict {
  if (!registrations) {
    return 'unknown'
  }
  const name = distro.trim().toLowerCase()
  const guid = distroGuid?.trim().replace(/[{}]/g, '').toLowerCase()
  const byName = registrations.find((entry) => entry.distro.toLowerCase() === name)
  const byGuid = guid ? registrations.find((entry) => entry.id === guid) : undefined
  if (!byName && !byGuid) {
    return 'gone'
  }
  // A move recorded without a GUID cannot tell a re-register from the original.
  return byName && guid && !byGuid ? 'replaced' : 'present'
}
