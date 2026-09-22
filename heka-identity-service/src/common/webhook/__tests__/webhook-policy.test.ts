import dns from 'node:dns/promises'

import {
  addressIsBlockedForWebhook,
  hostnameIsBlockedForWebhook,
  normalizeWebhookHostname,
  resolveValidatedWebhookAddresses,
} from 'common/webhook/webhook-policy'

const DEFAULT = { allowPrivateAddresses: false } as const
const PERMISSIVE = { allowPrivateAddresses: true } as const

describe('addressIsBlockedForWebhook', () => {
  describe('IPv4', () => {
    test.each([
      ['142.251.209.206', false],
      ['1.1.1.1', false],
      ['127.0.0.1', true],
      ['192.168.1.9', true],
      ['10.33.44.55', true],
      ['172.31.254.254', true],
      // Cloud metadata endpoint (link-local)
      ['169.254.169.254', true],
      ['0.0.0.0', true],
      ['100.64.0.1', true],
      ['224.0.0.1', true],
      ['255.255.255.255', true],
      ['240.0.0.1', true],
      // TEST-NET-1/2/3 and RFC2544 benchmarking: covered by ipaddr's `reserved` range
      ['192.0.2.1', true],
      ['198.51.100.1', true],
      ['203.0.113.88', true],
      ['198.18.0.1', true],
      // Not an address at all
      ['not-an-ip', true],
      ['', true],
    ])('%s blocked=%s', (address: string, blocked: boolean) => {
      expect(addressIsBlockedForWebhook(address, DEFAULT)).toBe(blocked)
    })
  })

  describe('IPv6', () => {
    test.each([
      ['2001:4860:4860::8888', false],
      ['::1', true],
      ['fe80::dead:beef:cafe:babe', true],
      ['fc01::42', true],
      ['fd01::1234', true],
      ['2001:db8::1', true],
      ['2002::1', true],
      ['64:ff9b::1', true],
      ['::', true],
      ['ff02::1', true],
      // IPv4-mapped forms must be unwrapped before the range check
      ['::ffff:127.0.0.1', true],
      ['::ffff:8.8.8.8', false],
    ])('%s blocked=%s', (address: string, blocked: boolean) => {
      expect(addressIsBlockedForWebhook(address, DEFAULT)).toBe(blocked)
    })
  })

  test('allowPrivateAddresses permits private targets but never malformed input', () => {
    expect(addressIsBlockedForWebhook('127.0.0.1', PERMISSIVE)).toBe(false)
    expect(addressIsBlockedForWebhook('192.168.1.9', PERMISSIVE)).toBe(false)
    expect(addressIsBlockedForWebhook('::1', PERMISSIVE)).toBe(false)
    expect(addressIsBlockedForWebhook('not-an-ip', PERMISSIVE)).toBe(true)
  })
})

describe('normalizeWebhookHostname', () => {
  test.each([
    ['LOCALHOST', 'localhost'],
    ['  Hooks.Example.COM  ', 'hooks.example.com'],
    ['metadata.google.internal.', 'metadata.google.internal'],
    ['[::1]', '::1'],
    ['[2001:db8::1]', '2001:db8::1'],
  ])('%s -> %s', (raw: string, expected: string) => {
    expect(normalizeWebhookHostname(raw)).toBe(expected)
  })
})

describe('hostnameIsBlockedForWebhook', () => {
  test('blocks reserved hostnames regardless of casing, padding and trailing dot', () => {
    expect(hostnameIsBlockedForWebhook('LOCALHOST', DEFAULT)).toBe(true)
    expect(hostnameIsBlockedForWebhook(' localhost ', DEFAULT)).toBe(true)
    expect(hostnameIsBlockedForWebhook('metadata.google.internal', DEFAULT)).toBe(true)
    expect(hostnameIsBlockedForWebhook('metadata.google.internal.', DEFAULT)).toBe(true)
    expect(hostnameIsBlockedForWebhook('metadata.goog', DEFAULT)).toBe(true)
    expect(hostnameIsBlockedForWebhook('kubernetes.default', DEFAULT)).toBe(true)
    expect(hostnameIsBlockedForWebhook('kubernetes.default.svc', DEFAULT)).toBe(true)
  })

  test('blocks internal DNS suffixes', () => {
    expect(hostnameIsBlockedForWebhook('evil.internal', DEFAULT)).toBe(true)
    expect(hostnameIsBlockedForWebhook('svc.cluster.local', DEFAULT)).toBe(true)
    expect(hostnameIsBlockedForWebhook('svc.my.localhost', DEFAULT)).toBe(true)
  })

  test('allows ordinary hostnames', () => {
    expect(hostnameIsBlockedForWebhook('hooks.example.com', DEFAULT)).toBe(false)
  })

  test('allowPrivateAddresses lifts the hostname rules', () => {
    expect(hostnameIsBlockedForWebhook('localhost', PERMISSIVE)).toBe(false)
    expect(hostnameIsBlockedForWebhook('webhook-sink.internal', PERMISSIVE)).toBe(false)
  })
})

describe('resolveValidatedWebhookAddresses', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  test('rejects a blocked IPv4 literal without touching DNS', async () => {
    const lookup = vi.spyOn(dns, 'lookup')
    await expect(resolveValidatedWebhookAddresses('127.0.0.1', DEFAULT)).rejects.toMatchObject({ policyCode: 'ADDR' })
    expect(lookup).not.toHaveBeenCalled()
  })

  test('rejects a bracketed IPv6 literal as a blocked address, not as an unresolvable name', async () => {
    await expect(resolveValidatedWebhookAddresses('[::1]', DEFAULT)).rejects.toMatchObject({ policyCode: 'ADDR' })
    await expect(resolveValidatedWebhookAddresses('[::ffff:7f00:1]', DEFAULT)).rejects.toMatchObject({
      policyCode: 'ADDR',
    })
  })

  test('returns a public literal with its address family', async () => {
    await expect(resolveValidatedWebhookAddresses('1.1.1.1', DEFAULT)).resolves.toEqual([
      { address: '1.1.1.1', family: 4 },
    ])
    await expect(resolveValidatedWebhookAddresses('[2001:4860:4860::8888]', DEFAULT)).resolves.toEqual([
      { address: '2001:4860:4860::8888', family: 6 },
    ])
  })

  test('rejects a blocked hostname before resolving it', async () => {
    const lookup = vi.spyOn(dns, 'lookup')
    await expect(resolveValidatedWebhookAddresses('x.internal', DEFAULT)).rejects.toMatchObject({ policyCode: 'HOST' })
    expect(lookup).not.toHaveBeenCalled()
  })

  test('returns every resolved address when all of them pass', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '142.251.209.206', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ] as never)

    await expect(resolveValidatedWebhookAddresses('hooks.example.com', DEFAULT)).resolves.toEqual([
      { address: '142.251.209.206', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])
  })

  test('rejects when any resolved address is blocked (DNS rebinding to an internal target)', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '142.251.209.206', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ] as never)

    await expect(resolveValidatedWebhookAddresses('rebind.example.com', DEFAULT)).rejects.toMatchObject({
      policyCode: 'ADDR',
    })
  })

  test('allowPrivateAddresses accepts a resolved private address', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '172.18.0.5', family: 4 }] as never)

    await expect(resolveValidatedWebhookAddresses('webhook-sink', PERMISSIVE)).resolves.toEqual([
      { address: '172.18.0.5', family: 4 },
    ])
  })

  test('maps a DNS failure to DNS', async () => {
    vi.spyOn(dns, 'lookup').mockRejectedValue(Object.assign(new Error('nf'), { code: 'ENOTFOUND' }))

    await expect(resolveValidatedWebhookAddresses('nonexistent.invalid', DEFAULT)).rejects.toMatchObject({
      policyCode: 'DNS',
    })
  })

  test('maps an empty DNS answer to DNS', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([] as never)

    await expect(resolveValidatedWebhookAddresses('empty.example.com', DEFAULT)).rejects.toMatchObject({
      policyCode: 'DNS',
    })
  })

  test('maps a hanging DNS resolution to TIMEOUT', async () => {
    vi.useFakeTimers()
    vi.spyOn(dns, 'lookup').mockReturnValue(new Promise(() => undefined) as never)

    const pending = resolveValidatedWebhookAddresses('slow.example.com', DEFAULT)
    const assertion = expect(pending).rejects.toMatchObject({ policyCode: 'TIMEOUT' })

    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })
})
