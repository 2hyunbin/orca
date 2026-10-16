import { isIP } from 'node:net'
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'

export type BrowserNetworkTunnelProxy =
  | { kind: 'direct' }
  | { kind: 'http'; url: URL }
  | { kind: 'socks5'; url: URL }
  | { kind: 'unsupported'; protocol: string }

/**
 * The upstream proxy a tunneled connection must use: Orca's proxy setting first, then the
 * environment's HTTPS/ALL/HTTP_PROXY, each with its own bypass list — the precedence the
 * host's own browser sessions apply (proxy-settings.ts).
 */
export function selectBrowserNetworkTunnelProxy(
  target: BrowserNetworkTunnelOpen,
  settings: NetworkProxySettings | null,
  env: Record<string, string | undefined>
): BrowserNetworkTunnelProxy {
  const configured = normalizeProxyUrl(settings?.httpProxyUrl)
  const fromSettings = configured.ok && configured.value !== ''
  const proxyUrl = fromSettings ? configured.value : getProxyUrlFromEnvironment(env).value
  if (!proxyUrl) {
    return { kind: 'direct' }
  }
  const bypassRules = fromSettings
    ? normalizeProxyBypassRules(settings?.httpProxyBypassRules)
    : getProxyBypassRulesFromEnvironment(env)
  if (
    isLoopbackHost(target.host) ||
    matchesProxyBypassRules(target, bypassRules, fromSettings ? 'chromium' : 'no-proxy')
  ) {
    return { kind: 'direct' }
  }
  const url = new URL(proxyUrl)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'http', url }
  }
  if (url.protocol === 'socks:' || url.protocol === 'socks5:') {
    return { kind: 'socks5', url }
  }
  return { kind: 'unsupported', protocol: url.protocol }
}

function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase()
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
}

// Why: Chromium never proxies loopback, and the host's own browser sessions follow it.
function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    (isIP(normalized) === 4 && normalized.startsWith('127.'))
  )
}

/**
 * Bypass rules: `*`, `<local>`, `.suffix`/`*suffix`, `host:port`, IPv4 CIDR. A bare host is exact
 * in Orca's setting (Chromium reads it so) and covers subdomains in NO_PROXY (curl/Go/Python).
 */
export function matchesProxyBypassRules(
  target: Pick<BrowserNetworkTunnelOpen, 'host' | 'port'>,
  rules: string,
  style: 'chromium' | 'no-proxy'
): boolean {
  const host = normalizeHost(target.host)
  return rules
    .split(';')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => matchesBypassRule(host, target.port, rule, style))
}

function matchesBypassRule(
  host: string,
  port: number,
  rule: string,
  style: 'chromium' | 'no-proxy'
): boolean {
  if (rule === '*') {
    return true
  }
  if (rule === '<local>') {
    return !host.includes('.') && !host.includes(':')
  }
  const withoutScheme = rule.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(withoutScheme)
  if (cidr) {
    return matchesIpv4Cidr(host, cidr[1]!, Number(cidr[2]))
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(withoutScheme)
  const hostPort = bracketed ? null : /^([^:]+):(\d+)$/.exec(withoutScheme)
  const ruleHost = bracketed?.[1] ?? hostPort?.[1] ?? withoutScheme
  const rulePort = bracketed?.[2] ?? hostPort?.[2]
  if (rulePort !== undefined && Number(rulePort) !== port) {
    return false
  }
  if (ruleHost.startsWith('*') && !ruleHost.startsWith('*.')) {
    // Chromium `*foo.com`: any host ending in the text, the bare domain included.
    return ruleHost.length > 1 && host.endsWith(ruleHost.slice(1))
  }
  const wildcard = ruleHost.startsWith('.') || ruleHost.startsWith('*.')
  const domain = ruleHost.replace(/^\*?\./, '')
  if (!domain) {
    return false
  }
  if (style === 'chromium') {
    return wildcard ? host.endsWith(`.${domain}`) : host === domain
  }
  return host === domain || host.endsWith(`.${domain}`)
}

function matchesIpv4Cidr(host: string, network: string, prefix: number): boolean {
  if (isIP(host) !== 4 || prefix > 32) {
    return false
  }
  const toInt = (address: string): number =>
    address.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (toInt(host) & mask) === (toInt(network) & mask)
}
