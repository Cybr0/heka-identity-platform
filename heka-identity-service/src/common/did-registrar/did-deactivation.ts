import type { DidDocumentMetadata, DidRecord } from '@credo-ts/core'

import { tryParseDid } from '@credo-ts/core'
import { UnprocessableEntityException } from '@nestjs/common'

import { TenantAgent } from '../agent'

/**
 * Tag set on the `DidRecord` of a DID that its wallet deactivated. The ledgers record the deactivation too, but the own
 * DID of a wallet is often resolved from its `DidRecord` (did:hedera), which carries no resolution metadata.
 */
export const DID_DEACTIVATED_TAG = 'hekaDeactivated'

export function isDidRecordDeactivated(didRecord: DidRecord): boolean {
  return didRecord.getTag(DID_DEACTIVATED_TAG) === true
}

/** Whether `did` (or the DID of a DID URL) is a DID of the tenant's wallet that the wallet deactivated. */
export async function isOwnDidDeactivated(tenantAgent: TenantAgent, did: string): Promise<boolean> {
  const didRecords = await tenantAgent.dids.getCreatedDids({ did: tryParseDid(did)?.did ?? did })
  return didRecords.some(isDidRecordDeactivated)
}

/**
 * Rejects a deactivated DID before it is used to sign or register anything new: deactivated on its ledger (per the
 * resolution metadata, when given) or by the tenant's wallet.
 */
export async function assertDidNotDeactivated(
  tenantAgent: TenantAgent,
  did: string,
  didDocumentMetadata?: DidDocumentMetadata,
): Promise<void> {
  if (didDocumentMetadata?.deactivated === true || (await isOwnDidDeactivated(tenantAgent, did))) {
    throw new UnprocessableEntityException(`DID is deactivated: ${did}`)
  }
}
