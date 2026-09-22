import dns from 'node:dns/promises'
import { isIP } from 'node:net'

import ipaddr from 'ipaddr.js'

/** Cap for resolving a webhook hostname while validating a callback URL (the HTTP timeout covers the send path). */
const DNS_RESOLUTION_TIMEOUT_MS = 5_000

/** Hostnames that commonly resolve to internal infrastructure regardless of what DNS answers. */
const RESERVED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.default',
  'kubernetes.default.svc',
])

const RESERVED_HOST_SUFFIXES = ['.local', '.internal', '.localhost']

export type WebhookPolicyCode = 'URL' | 'SCHEME' | 'CREDENTIALS' | 'HOST' | 'ADDR' | 'DNS' | 'TIMEOUT'

export class WebhookTargetPolicyError extends Error {
  public constructor(
    public readonly policyCode: WebhookPolicyCode,
    message: string,
  ) {
    super(message)
    this.name = 'WebhookTargetPolicyError'
  }
}

export type WebhookAddressPolicy = Readonly<{
  /** Development / Docker / CI escape hatch: permits loopback, private and reserved targets. */
  allowPrivateAddresses: boolean
}>

export type WebhookAddress = Readonly<{ address: string; family: 4 | 6 }>

/**
 * DNS hook shape shared by Node's `net.LookupFunction` and the axios `lookup` option.
 * Node (>= 20, `autoSelectFamily` on by default) calls it with `{ all: true }` and expects
 * the full address list; the single-address form is kept for callers that pass `all: false`.
 */
export type WebhookLookup = (
  hostname: string,
  options: { all?: boolean },
  callback: (error: NodeJS.ErrnoException | null, address: string | WebhookAddress[], family?: 4 | 6) => void,
) => void

/** Lowercases, trims, drops the DNS root dot and unwraps `[::1]`-style IPv6 literals. */
export function normalizeWebhookHostname(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Blocks anything that is not a globally routable unicast address (loopback, RFC1918, link-local, reserved, ...). */
export function addressIsBlockedForWebhook(address: string, policy: WebhookAddressPolicy): boolean {
  if (!ipaddr.isValid(address)) return true
  if (policy.allowPrivateAddresses) return false

  try {
    // `process` unwraps IPv4-mapped IPv6 (`::ffff:127.0.0.1` -> loopback).
    return ipaddr.process(address).range() !== 'unicast'
  } catch {
    return true
  }
}

export function hostnameIsBlockedForWebhook(hostname: string, policy: WebhookAddressPolicy): boolean {
  if (policy.allowPrivateAddresses) return false

  const host = normalizeWebhookHostname(hostname)
  return RESERVED_HOSTS.has(host) || RESERVED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/**
 * Resolves a webhook hostname and rejects it unless every answer is an allowed address.
 * Returns the validated addresses so that the caller can connect to exactly what was checked.
 */
export async function resolveValidatedWebhookAddresses(
  hostname: string,
  policy: WebhookAddressPolicy,
): Promise<WebhookAddress[]> {
  const host = normalizeWebhookHostname(hostname)
  if (!host) throw new WebhookTargetPolicyError('DNS', 'Webhook hostname is missing')

  if (hostnameIsBlockedForWebhook(host, policy)) {
    throw new WebhookTargetPolicyError('HOST', 'Webhook hostname is not permitted')
  }

  const literalFamily = isIP(host)
  if (literalFamily !== 0) {
    if (addressIsBlockedForWebhook(host, policy)) {
      throw new WebhookTargetPolicyError('ADDR', 'Webhook target address is not permitted')
    }
    return [{ address: host, family: literalFamily === 6 ? 6 : 4 }]
  }

  let resolved: WebhookAddress[]
  try {
    const answers = await withDnsTimeout(dns.lookup(host, { all: true }))
    resolved = answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }) as const)
  } catch (error: unknown) {
    if (error instanceof WebhookTargetPolicyError) throw error
    throw new WebhookTargetPolicyError('DNS', 'Webhook hostname could not be resolved')
  }

  if (resolved.length === 0) throw new WebhookTargetPolicyError('DNS', 'Webhook hostname could not be resolved')

  for (const { address } of resolved) {
    if (addressIsBlockedForWebhook(address, policy)) {
      throw new WebhookTargetPolicyError('ADDR', 'Webhook target address is not permitted')
    }
  }

  return resolved
}

/**
 * DNS hook for the outbound HTTP client: re-runs the address policy immediately before the TCP
 * connection and hands the socket only the addresses that just passed, leaving no window for
 * DNS rebinding between validation and connect.
 */
export function createWebhookLookup(policy: WebhookAddressPolicy): WebhookLookup {
  return (hostname, options, callback) => {
    void resolveValidatedWebhookAddresses(hostname, policy).then(
      (addresses) => {
        if (options.all) {
          callback(null, addresses)
          return
        }
        const [first] = addresses
        callback(null, first.address, first.family)
      },
      (error: unknown) => callback(toLookupError(error), '', undefined),
    )
  }
}

async function withDnsTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new WebhookTargetPolicyError('TIMEOUT', 'Webhook DNS lookup timed out')),
          DNS_RESOLUTION_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const LOOKUP_ERROR_CODES: Partial<Record<WebhookPolicyCode, string>> = {
  TIMEOUT: 'ETIMEDOUT',
  DNS: 'ENOTFOUND',
}

function toLookupError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof WebhookTargetPolicyError) {
    const lookupError: NodeJS.ErrnoException = new Error(`${error.message} (${error.policyCode})`)
    lookupError.code = LOOKUP_ERROR_CODES[error.policyCode] ?? 'EADDRNOTAVAIL'
    return lookupError
  }

  const lookupError: NodeJS.ErrnoException = new Error(
    error instanceof Error ? error.message : 'Webhook hostname could not be resolved',
  )
  lookupError.code = 'ENOTFOUND'
  return lookupError
}
