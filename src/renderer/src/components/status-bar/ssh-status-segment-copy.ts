import { translate } from '@/i18n/i18n'

export function connectedHostCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.SshStatusSegment.connectedHostCount_one',
        '{{count}} host',
        { count }
      )
    : translate(
        'auto.components.status.bar.SshStatusSegment.connectedHostCount_other',
        '{{count}} hosts',
        { count }
      )
}

export function connectingHostsLabel(): string {
  return translate('auto.components.status.bar.SshStatusSegment.connecting', 'Connecting…')
}

export function moreSshHostsLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.SshStatusSegment.moreSshHosts_one',
        '1 more SSH host. Search by name to find it.',
        { count }
      )
    : translate(
        'auto.components.status.bar.SshStatusSegment.moreSshHosts_other',
        '{{count}} more SSH hosts. Search by name to find one.',
        { count }
      )
}

export function searchSshHostsLabel(): string {
  return translate(
    'auto.components.status.bar.SshStatusSegment.searchSshHosts',
    'Search SSH hosts…'
  )
}

export function noMatchingSshHostsLabel(): string {
  return translate(
    'auto.components.status.bar.SshStatusSegment.noMatchingSshHosts',
    'No SSH hosts match.'
  )
}
