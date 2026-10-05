import { AgentContext, DidDocument } from '@credo-ts/core'
import { HederaLedgerService, HederaModuleConfig } from '@credo-ts/hedera'
import { createMock } from '@golevelup/ts-vitest'

import { HekaHederaLedgerService } from '../hedera'

describe('HekaHederaLedgerService', () => {
  const did = 'did:hedera:testnet:z6Mk_0.0.1'
  const createdDidDocument = { id: did, controller: 'did:hedera:testnet:controller' }
  let service: HekaHederaLedgerService
  let agentContext: AgentContext

  beforeEach(() => {
    service = new HekaHederaLedgerService(
      new HederaModuleConfig({ networks: [{ network: 'testnet', operatorId: '0.0.1', operatorKey: 'key' }] }),
    )
    agentContext = createMock<AgentContext>()
    vi.spyOn(service, 'resolveDid').mockResolvedValue({ didDocument: createdDidDocument } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('skips the update of a new DID whose document only carries the controller', async () => {
    const superUpdate = vi.spyOn(HederaLedgerService.prototype, 'updateDid')

    const result = await service.updateDid(agentContext, {
      did,
      didDocumentOperation: 'setDidDocument',
      didDocument: new DidDocument({ id: '', controller: ['did:hedera:testnet:controller'] }),
    })

    expect(result).toEqual({ did, didDocument: createdDidDocument })
    expect(service.resolveDid).toHaveBeenCalledWith(agentContext, did)
    expect(superUpdate).not.toHaveBeenCalled()
  })

  test('applies any other update as Credo does', async () => {
    const superUpdate = vi.spyOn(HederaLedgerService.prototype, 'updateDid').mockResolvedValue({} as any)
    const didDocument = new DidDocument({
      id: did,
      service: [{ id: '#service-1', type: 'LinkedDomains', serviceEndpoint: 'https://example.com' }],
    })

    await service.updateDid(agentContext, { did, didDocumentOperation: 'setDidDocument', didDocument })
    await service.updateDid(agentContext, { did, didDocumentOperation: 'addToDidDocument', didDocument })

    expect(superUpdate).toHaveBeenCalledTimes(2)
    expect(service.resolveDid).not.toHaveBeenCalled()
  })
})
