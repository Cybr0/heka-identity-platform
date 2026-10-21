import { AgentContext, DidRepository, DidsApi, Kms, TypedArrayEncoder } from '@credo-ts/core'
import { getBytes, SigningKey } from 'ethers'

import { DidRegistry, IndyBesuSigner } from '../../ledger'
import { IndyBesuDidRegistrar } from '../IndyBesuDidRegistrar'

const OWNER_PRIVATE_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const OWNER_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23'
const DID = `did:indybesu:testnet:${OWNER_ADDRESS}`

function secp256k1PublicJwk(privateKeyHex: string): Kms.KmsJwkPublicAsymmetric {
  const uncompressed = getBytes(new SigningKey(`0x${privateKeyHex}`).publicKey)
  return {
    kty: 'EC',
    crv: 'secp256k1',
    x: TypedArrayEncoder.toBase64Url(uncompressed.slice(1, 33)),
    y: TypedArrayEncoder.toBase64Url(uncompressed.slice(33, 65)),
  }
}

function registrarContext() {
  const didRegistry = {
    endorseDid: vi.fn(),
    updateDid: vi.fn(),
    deactivateDid: vi.fn(),
    resolveDid: vi.fn(),
  }
  const didsApi = { import: vi.fn() }
  const kms = {
    createKey: vi.fn().mockResolvedValue({ keyId: 'owner-key', publicJwk: secp256k1PublicJwk(OWNER_PRIVATE_KEY) }),
    deleteKey: vi.fn().mockResolvedValue(true),
  }
  const didRepository = { findCreatedDid: vi.fn(), update: vi.fn() }
  const agentContext = {
    dependencyManager: {
      resolve: vi.fn((token: unknown) => {
        if (token === DidRegistry) return didRegistry
        if (token === DidsApi) return didsApi
        if (token === DidRepository) return didRepository
        return kms
      }),
    },
  } as unknown as AgentContext
  return { agentContext, didRegistry, didsApi, kms, didRepository }
}

describe('IndyBesuDidRegistrar', () => {
  const registrar = new IndyBesuDidRegistrar()
  let context: ReturnType<typeof registrarContext>

  beforeEach(() => {
    context = registrarContext()
    vi.spyOn(IndyBesuSigner, 'create').mockImplementation((_agentContext, keyId) =>
      Promise.resolve({ address: keyId === 'owner-key' ? OWNER_ADDRESS : '0xEndorser' } as IndyBesuSigner),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('create', () => {
    const createOptions = { method: 'indybesu', options: { network: 'testnet', endorserKeyId: 'endorser' } } as const

    test('writes the DID of the new key, endorsed, and keeps the owner key as `#KEY-1`', async () => {
      const result = await registrar.create(context.agentContext, createOptions)

      expect(result.didState).toMatchObject({ state: 'finished', did: DID })
      const [ledgerDocument, identity, endorser] = context.didRegistry.endorseDid.mock.calls[0]
      expect(identity.address).toBe(OWNER_ADDRESS)
      expect(endorser.address).toBe('0xEndorser')
      // Plain JSON, with the owner key first and one key-material property
      expect(ledgerDocument).toEqual({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: DID,
        controller: [],
        verificationMethod: [
          {
            id: `${DID}#KEY-1`,
            type: 'EcdsaSecp256k1VerificationKey2019',
            controller: DID,
            publicKeyBase58: expect.any(String),
          },
        ],
        authentication: [`${DID}#KEY-1`],
        assertionMethod: [`${DID}#KEY-1`],
        capabilityInvocation: [],
        capabilityDelegation: [],
        keyAgreement: [],
        service: [],
        alsoKnownAs: [],
      })
      expect(context.didsApi.import).toHaveBeenCalledWith(
        expect.objectContaining({ did: DID, keys: [{ kmsKeyId: 'owner-key', didDocumentRelativeKeyId: '#KEY-1' }] }),
      )
      expect(context.kms.deleteKey).not.toHaveBeenCalled()
    })

    test('deletes the generated key when the ledger write fails', async () => {
      context.didRegistry.endorseDid.mockRejectedValue(new Error('Ledger Client: Transaction reverted'))

      const result = await registrar.create(context.agentContext, createOptions)

      expect(result.didState).toEqual({
        state: 'failed',
        reason: 'unknownError: Ledger Client: Transaction reverted',
      })
      expect(context.kms.deleteKey).toHaveBeenCalledWith({ keyId: 'owner-key' })
      expect(context.didsApi.import).not.toHaveBeenCalled()
    })

    test('keeps the key of a DID that is already on the ledger', async () => {
      context.didsApi.import.mockRejectedValue(new Error('storage down'))

      const result = await registrar.create(context.agentContext, createOptions)

      expect(result.didState.state).toBe('failed')
      expect(context.kms.deleteKey).not.toHaveBeenCalled()
    })
  })
})
