import type { ConfigType } from '@nestjs/config'

import { createMock } from '@golevelup/ts-vitest'
import { UnprocessableEntityException } from '@nestjs/common'

import { TenantAgent } from 'common/agent'
import AgentConfig from 'config/agent'

import { didRecordStub } from '../../../../test/helpers/mock-records'
import { AnoncredsRegistryService } from '../anoncreds-registry.service'

describe('AnoncredsRegistryService', () => {
  const issuerId = 'did:hedera:testnet:z6Mk_0.0.1'
  const schemaId = `${issuerId}/anoncreds/v0/SCHEMA/0.0.2`
  const credentialDefinitionId = `${issuerId}/anoncreds/v0/CLAIM_DEF/0.0.3`

  let service: AnoncredsRegistryService
  let tenantAgent: TenantAgent

  const deactivatedRecord = () => didRecordStub({ did: issuerId, getTag: (name: string) => name === 'hekaDeactivated' })

  beforeEach(() => {
    service = new AnoncredsRegistryService({
      credentialsConfiguration: { Aries: { networks: ['hedera'] } },
    } as unknown as ConfigType<typeof AgentConfig>)
    tenantAgent = createMock<TenantAgent>({
      dids: { getCreatedDids: vi.fn().mockResolvedValue([]) },
      modules: {
        anoncreds: {
          registerSchema: vi.fn().mockResolvedValue({
            schemaState: {
              state: 'finished',
              schemaId,
              schema: { issuerId, name: 'Test', version: '1.0', attrNames: ['name'] },
            },
          }),
          registerCredentialDefinition: vi.fn().mockResolvedValue({
            credentialDefinitionState: {
              state: 'finished',
              credentialDefinitionId,
              credentialDefinition: { issuerId, schemaId, tag: 'default', type: 'CL', value: {} },
            },
          }),
          registerRevocationRegistryDefinition: vi.fn().mockResolvedValue({
            revocationRegistryDefinitionState: {
              state: 'finished',
              revocationRegistryDefinitionId: `${issuerId}/anoncreds/v0/REV_REG/0.0.4`,
              revocationRegistryDefinition: {},
            },
          }),
        },
      },
    })
  })

  describe('registerSchema', () => {
    const schema = { issuerId, name: 'Test', version: '1.0', attrNames: ['name'] }

    test('registers a schema for an active DID', async () => {
      const result = await service.registerSchema(tenantAgent, schema)

      expect(result.schemaId).toBe(schemaId)
      expect(tenantAgent.dids.getCreatedDids).toHaveBeenCalledWith({ did: issuerId })
      expect(tenantAgent.modules.anoncreds.registerSchema).toHaveBeenCalledWith({ schema, options: {} })
    })

    test('rejects a DID the wallet deactivated with 422 and writes nothing', async () => {
      vi.mocked(tenantAgent.dids.getCreatedDids).mockResolvedValue([deactivatedRecord()])

      const registration = service.registerSchema(tenantAgent, schema)

      await expect(registration).rejects.toThrow(UnprocessableEntityException)
      await expect(registration).rejects.toThrow(`DID is deactivated: ${issuerId}`)
      expect(tenantAgent.modules.anoncreds.registerSchema).not.toHaveBeenCalled()
    })
  })

  describe('registerCredentialDefinition', () => {
    const credentialDefinition = { issuerId, schemaId, tag: 'default' }

    test('registers a credential definition for an active DID', async () => {
      const result = await service.registerCredentialDefinition(tenantAgent, credentialDefinition)

      expect(result.credentialDefinitionId).toBe(credentialDefinitionId)
      expect(tenantAgent.dids.getCreatedDids).toHaveBeenCalledWith({ did: issuerId })
      expect(tenantAgent.modules.anoncreds.registerCredentialDefinition).toHaveBeenCalledOnce()
    })

    test('rejects a DID the wallet deactivated with 422 and writes nothing', async () => {
      vi.mocked(tenantAgent.dids.getCreatedDids).mockResolvedValue([deactivatedRecord()])

      const registration = service.registerCredentialDefinition(tenantAgent, credentialDefinition)

      await expect(registration).rejects.toThrow(UnprocessableEntityException)
      await expect(registration).rejects.toThrow(`DID is deactivated: ${issuerId}`)
      expect(tenantAgent.modules.anoncreds.registerCredentialDefinition).not.toHaveBeenCalled()
    })
  })

  describe('registerRevocationRegistryDefinition', () => {
    test('stays allowed for a deactivated DID (credentials issued before stay revocable)', async () => {
      vi.mocked(tenantAgent.dids.getCreatedDids).mockResolvedValue([deactivatedRecord()])

      await service.registerRevocationRegistryDefinition(tenantAgent, issuerId, credentialDefinitionId, 10)

      expect(tenantAgent.modules.anoncreds.registerRevocationRegistryDefinition).toHaveBeenCalledOnce()
    })
  })
})
