import { Kms } from '@credo-ts/core'
import { ConfigType } from '@nestjs/config'

import { TenantAgent } from 'common/agent'
import AgentConfig from 'config/agent'
import { INSECURE_DEFAULTS } from 'config/insecure-defaults'

import { assertIndyBesuEndorserKeyPair, DidIndyBesuRegistrar, ensureIndyBesuEndorserKey } from '../methods/did-indybesu'

// The compressed public key of the dev endorser key (the default of INDY_BESU_ENDORSER_PUBLIC_KEY)
const DEV_PUBLIC_KEY = '03af80b90d25145da28c583359beb47b21796b2fe1a23c1511e443e7a64dfdb27d'
const endorserConfig = {
  indyBesuEndorserPrivateKey: INSECURE_DEFAULTS.INDY_BESU_ENDORSER_PRIVATE_KEY,
  indyBesuEndorserPublicKey: DEV_PUBLIC_KEY,
}

/** A KMS that holds keys by id, like Askar: a second import of the same id fails with `KeyManagementKeyExistsError`. */
function inMemoryKms() {
  const keys = new Map<string, Kms.KmsJwkPrivate>()
  return {
    keys,
    getPublicKey: vi.fn(({ keyId }: { keyId: string }) => {
      const key = keys.get(keyId)
      if (!key) return Promise.reject(new Kms.KeyManagementKeyNotFoundError(keyId, ['askar']))
      return Promise.resolve(Kms.publicJwkFromPrivateJwk(key))
    }),
    importKey: vi.fn(({ privateJwk }: { privateJwk: Kms.KmsJwkPrivate }) => {
      const keyId = privateJwk.kid as string
      if (keys.has(keyId)) return Promise.reject(new Kms.KeyManagementKeyExistsError(keyId, 'askar'))
      keys.set(keyId, privateJwk)
      return Promise.resolve({ keyId, publicJwk: Kms.publicJwkFromPrivateJwk(privateJwk) })
    }),
  }
}

describe('did:indybesu registrar wrapper', () => {
  describe('endorser key pair check', () => {
    test('accepts the configured key pair', () => {
      expect(() => assertIndyBesuEndorserKeyPair(endorserConfig)).not.toThrow()
      expect(() =>
        assertIndyBesuEndorserKeyPair({
          ...endorserConfig,
          indyBesuEndorserPublicKey: `0x${DEV_PUBLIC_KEY.toUpperCase()}`,
        }),
      ).not.toThrow()
    })

    test('rejects a public key of another private key, without key material in the message', () => {
      const otherPublicKey = '02' + '11'.repeat(32)

      let message = ''
      try {
        assertIndyBesuEndorserKeyPair({ ...endorserConfig, indyBesuEndorserPublicKey: otherPublicKey })
      } catch (error) {
        message = (error as Error).message
      }

      expect(message).toBe('INDY_BESU_ENDORSER_PUBLIC_KEY does not match INDY_BESU_ENDORSER_PRIVATE_KEY')
      expect(message).not.toContain(INSECURE_DEFAULTS.INDY_BESU_ENDORSER_PRIVATE_KEY)
    })

    test('rejects an invalid private key', () => {
      expect(() => assertIndyBesuEndorserKeyPair({ ...endorserConfig, indyBesuEndorserPrivateKey: 'zz' })).toThrow(
        'INDY_BESU_ENDORSER_PRIVATE_KEY is not a valid secp256k1 private key (hex)',
      )
    })

    test('the registrar refuses to start with a mismatched pair', () => {
      const agencyConfig = {
        ...endorserConfig,
        indyBesuEndorserPublicKey: '02' + '11'.repeat(32),
        indyBesuNetwork: 'testnet',
      } as ConfigType<typeof AgentConfig>

      expect(() => new DidIndyBesuRegistrar(agencyConfig)).toThrow('INDY_BESU_ENDORSER_PUBLIC_KEY does not match')
    })
  })

  describe('ensureIndyBesuEndorserKey', () => {
    test('imports the configured secp256k1 key under the public key as key id', async () => {
      const kms = inMemoryKms()

      const keyId = await ensureIndyBesuEndorserKey({ kms } as unknown as TenantAgent, endorserConfig)

      expect(keyId).toBe(DEV_PUBLIC_KEY)
      expect(kms.importKey).toHaveBeenCalledTimes(1)
      expect(kms.keys.get(DEV_PUBLIC_KEY)).toMatchObject({ kty: 'EC', crv: 'secp256k1', kid: DEV_PUBLIC_KEY })
    })

    test('a second call leaves exactly one key and does not import again', async () => {
      const kms = inMemoryKms()
      const tenantAgent = { kms } as unknown as TenantAgent

      await ensureIndyBesuEndorserKey(tenantAgent, endorserConfig)
      await ensureIndyBesuEndorserKey(tenantAgent, endorserConfig)

      expect(kms.keys.size).toBe(1)
      expect(kms.importKey).toHaveBeenCalledTimes(1)
    })

    test('a key imported concurrently (KeyManagementKeyExistsError) counts as imported', async () => {
      const kms = inMemoryKms()
      kms.getPublicKey.mockRejectedValueOnce(new Kms.KeyManagementKeyNotFoundError(DEV_PUBLIC_KEY, ['askar']))
      kms.importKey.mockRejectedValueOnce(new Kms.KeyManagementKeyExistsError(DEV_PUBLIC_KEY, 'askar'))

      await expect(ensureIndyBesuEndorserKey({ kms } as unknown as TenantAgent, endorserConfig)).resolves.toBe(
        DEV_PUBLIC_KEY,
      )
    })

    test('other KMS errors are not swallowed', async () => {
      const kms = inMemoryKms()
      kms.getPublicKey.mockRejectedValueOnce(new Error('store closed'))

      await expect(ensureIndyBesuEndorserKey({ kms } as unknown as TenantAgent, endorserConfig)).rejects.toThrow(
        'store closed',
      )
      expect(kms.importKey).not.toHaveBeenCalled()
    })
  })
})
