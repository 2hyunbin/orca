import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'

/** The name a server gets when the user leaves Name blank: the link's host. */
export function defaultServerNameForAccessLink(accessLink: string): string {
  const parsed = parseHostAccessLink(accessLink)
  if (!parsed.ok) {
    return ''
  }
  try {
    return new URL(`ws://${parsed.value.displayEndpoint}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return parsed.value.displayEndpoint
  }
}
