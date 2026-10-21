import type { DidCreateResult } from '@credo-ts/core'

import { transformPrivateKeyToPrivateJwk } from '@credo-ts/askar'
import { Kms, TypedArrayEncoder } from '@credo-ts/core'
import { ConfigType } from '@nestjs/config'
import { SigningKey } from 'ethers'

import AgentConfig from '../../../config/agent'
import { TenantAgent } from '../../agent'
import { IndyBesuDidCreateOptions } from '../../indy-besu-vdr'
import { CreateDidOptions, DidRegistrar } from '../did-registrar.types'

type IndyBesuEndorserConfig = Pick<
  ConfigType<typeof AgentConfig>,
  'indyBesuEndorserPrivateKey' | 'indyBesuEndorserPublicKey'
>

/**
 * Throws when the configured endorser public key is not the one of the private key. The message names the variables
 * only, never key material.
 */
export function assertIndyBesuEndorserKeyPair(agencyConfig: IndyBesuEndorserConfig): void {
  let derived: string
  try {
    derived = new SigningKey(`0x${agencyConfig.indyBesuEndorserPrivateKey}`).compressedPublicKey
  } catch {
    throw new Error('INDY_BESU_ENDORSER_PRIVATE_KEY is not a valid secp256k1 private key (hex)')
  }
  if (derived.slice(2).toLowerCase() !== agencyConfig.indyBesuEndorserPublicKey.replace(/^0x/, '').toLowerCase()) {
    throw new Error('INDY_BESU_ENDORSER_PUBLIC_KEY does not match INDY_BESU_ENDORSER_PRIVATE_KEY')
  }
}

/**
 * Imports the configured Indy-Besu endorser key into the tenant's KMS unless it is there, and returns its KMS key id.
 * The key id is the configured public key, the id the Indy-Besu AnonCreds registrar passes as `endorserKey`.
 */
export async function ensureIndyBesuEndorserKey(
  tenantAgent: TenantAgent,
  agencyConfig: IndyBesuEndorserConfig,
): Promise<string> {
  const keyId = agencyConfig.indyBesuEndorserPublicKey

  // Checked first, so the usual case does not run into a failed insert (and its rollback) in Askar
  try {
    await tenantAgent.kms.getPublicKey({ keyId })
    return keyId
  } catch (error) {
    if (!(error instanceof Kms.KeyManagementKeyNotFoundError)) {
      throw error
    }
  }

  const { privateJwk } = transformPrivateKeyToPrivateJwk({
    privateKey: TypedArrayEncoder.fromHex(agencyConfig.indyBesuEndorserPrivateKey),
    type: { kty: 'EC', crv: 'secp256k1' },
  })
  try {
    await tenantAgent.kms.importKey({ privateJwk: { ...privateJwk, kid: keyId } })
  } catch (error) {
    // Imported by a concurrent request in the meantime
    if (!(error instanceof Kms.KeyManagementKeyExistsError)) {
      throw error
    }
  }
  return keyId
}

export class DidIndyBesuRegistrar implements DidRegistrar {
  public static readonly method = 'indybesu'

  // The Indy-Besu registrar writes the DID as its own controller. Whether the ledger contract accepts another
  // controller is not verified yet. Tracked as a follow-up.
  public readonly supportsController = false

  private readonly network!: string
  private readonly endorserConfig!: IndyBesuEndorserConfig

  public constructor(agencyConfig: ConfigType<typeof AgentConfig>) {
    assertIndyBesuEndorserKeyPair(agencyConfig)
    this.network = agencyConfig.indyBesuNetwork
    this.endorserConfig = {
      indyBesuEndorserPrivateKey: agencyConfig.indyBesuEndorserPrivateKey,
      indyBesuEndorserPublicKey: agencyConfig.indyBesuEndorserPublicKey,
    }
  }

  public async createDid(tenantAgent: TenantAgent, options: CreateDidOptions): Promise<DidCreateResult> {
    const endorserKeyId = await ensureIndyBesuEndorserKey(tenantAgent, this.endorserConfig)

    return await tenantAgent.dids.create<IndyBesuDidCreateOptions>({
      method: DidIndyBesuRegistrar.method,
      options: {
        network: this.network,
        endorserKeyId,
      },
      secret: {},
    })
  }
}
