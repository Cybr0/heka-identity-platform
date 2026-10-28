import { Agent } from '@credo-ts/core'
import AsyncStorage from '@react-native-async-storage/async-storage'

import {
  createPublicInvitationOrGetExisting,
  createPublicInvitationWhenMediatorReady,
  trySetupMediator,
} from '../../src/utils/agent'

// utils/agent.ts eagerly imports native/ESM Credo modules and agent setup helpers.
// Only the mediator and public invitation helpers are tested here, so the rest is mocked out.
jest.mock('@bifold/react-hooks', () => ({ useOptionalAgent: jest.fn() }))
jest.mock('@credo-ts/anoncreds', () => ({}))
jest.mock('@credo-ts/hedera', () => ({}))
jest.mock('@credo-ts/indy-vdr', () => ({}))
jest.mock('@hyperledger/anoncreds-react-native', () => ({ NativeAnoncreds: {} }))
jest.mock(
  '@credo-ts/didcomm/build/modules/connections/services/helpers.mjs',
  () => ({ createPeerDidFromServices: jest.fn(), routingToServices: jest.fn() }),
  { virtual: true }
)
jest.mock('../../src/credentials/metadata', () => ({ setOpenId4VcCredentialMetadata: jest.fn() }))
jest.mock('../../src/indy-besu', () => ({ IndyBesuDidResolver: jest.fn() }))
jest.mock('../../src/indy-besu/anoncreds', () => ({ IndyBesuAnoncredsRegistry: jest.fn() }))
jest.mock('../../src/logger', () => ({ CredoLogger: jest.fn() }))
jest.mock('../../src/utils/did', () => ({ getDidKeyVerificationMethodId: jest.fn() }))
jest.mock('../../src/utils/revocation/TailsService', () => ({ TailsService: jest.fn() }))

const PUBLIC_DID_KEY = 'PUBLIC_DID'
const PUBLIC_INVITATION_ID_KEY = 'PUBLIC_INVITATION_ID'

const publicDid = 'did:peer:2.mock-public-did'
const mediatorInvitationUrl = 'https://mediator.example/invite?oob=mock'
const label = 'Test Wallet'

const routedDidDocument = {
  didCommServices: [{ type: 'did-communication', routingKeys: ['did:key:mock-mediator-routing-key'] }],
}

const unroutedDidDocument = {
  didCommServices: [{ type: 'did-communication', routingKeys: [] }],
}

const mediatorOutOfBandInvitation = { id: 'mediator-invitation-id' }
const mediatorRouting = { endpoints: ['didcomm:transport/queue'], recipientKey: 'mock-recipient-key', routingKeys: [] }
const mediatorConnectionRecord = { id: 'mediator-connection-id', state: 'request-sent' }
const connectedMediatorConnectionRecord = { id: 'mediator-connection-id', state: 'completed' }
const mediationRecord = { id: 'mediation-record-id' }

interface MockAgentOptions {
  // Default mediator found on startup, null means the mediator has to be connected first
  defaultMediator?: { id: string } | null
}

function createMockAgent({ defaultMediator = { id: 'mediation-record-id' } }: MockAgentOptions = {}) {
  const invitationRecord = {
    id: 'new-invitation-id',
    outOfBandInvitation: { toUrl: jest.fn(() => 'didcomm://invite?oob=new') },
  }

  const mockAgent = {
    isInitialized: true,
    config: {
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    },
    dids: {
      resolveDidDocument: jest.fn().mockResolvedValue(routedDidDocument),
      getCreatedDids: jest.fn().mockResolvedValue([{ did: publicDid }]),
    },
    didcomm: {
      mediationRecipient: {
        // By default a default mediator already exists, so the mediator setup succeeds without connecting
        findDefaultMediator: jest.fn().mockResolvedValue(defaultMediator),
        getRouting: jest.fn().mockResolvedValue(mediatorRouting),
        requestAndAwaitGrant: jest.fn().mockResolvedValue(mediationRecord),
        setDefaultMediator: jest.fn().mockResolvedValue(undefined),
        initiateMessagePickup: jest.fn().mockResolvedValue(undefined),
      },
      oob: {
        createInvitation: jest.fn().mockResolvedValue(invitationRecord),
        findById: jest.fn(),
        parseInvitation: jest.fn().mockResolvedValue(mediatorOutOfBandInvitation),
        findByReceivedInvitationId: jest.fn().mockResolvedValue(null),
        receiveInvitation: jest.fn().mockResolvedValue({ connectionRecord: mediatorConnectionRecord }),
        deleteById: jest.fn().mockResolvedValue(undefined),
      },
      connections: {
        returnWhenIsConnected: jest.fn().mockResolvedValue(connectedMediatorConnectionRecord),
        findAllByOutOfBandId: jest.fn().mockResolvedValue([]),
        deleteById: jest.fn().mockResolvedValue(undefined),
      },
    },
  }

  return { mockAgent, agent: mockAgent as unknown as Agent, invitationRecord }
}

describe('Agent utils', () => {
  beforeEach(async () => {
    await AsyncStorage.clear()
  })

  describe('createPublicInvitationOrGetExisting', () => {
    it('uses the public DID as invitation DID when it is routed through a mediator', async () => {
      const { mockAgent, agent } = createMockAgent()
      mockAgent.dids.resolveDidDocument.mockResolvedValueOnce(routedDidDocument)

      const invitationUrl = await createPublicInvitationOrGetExisting(agent, publicDid, label)

      expect(mockAgent.dids.resolveDidDocument).toHaveBeenCalledWith(publicDid)
      expect(mockAgent.didcomm.oob.createInvitation).toHaveBeenCalledTimes(1)
      expect(mockAgent.didcomm.oob.createInvitation).toHaveBeenCalledWith({
        label,
        invitationDid: publicDid,
        multiUseInvitation: true,
      })
      expect(await AsyncStorage.getItem(PUBLIC_INVITATION_ID_KEY)).toBe('new-invitation-id')
      expect(invitationUrl).toBe('didcomm://invite?oob=new')
    })

    it('does not reference the public DID when it is not routed through a mediator', async () => {
      const { mockAgent, agent } = createMockAgent()
      mockAgent.dids.resolveDidDocument.mockResolvedValueOnce(unroutedDidDocument)

      await createPublicInvitationOrGetExisting(agent, publicDid, label)

      expect(mockAgent.didcomm.oob.createInvitation).toHaveBeenCalledTimes(1)
      const [invitationConfig] = mockAgent.didcomm.oob.createInvitation.mock.calls[0]
      expect(invitationConfig.invitationDid).toBeUndefined()
      expect(invitationConfig.routing).toBeUndefined()
      expect(invitationConfig).toMatchObject({ label, multiUseInvitation: true })
      expect(await AsyncStorage.getItem(PUBLIC_INVITATION_ID_KEY)).toBe('new-invitation-id')
    })

    it('treats a DID document without DIDComm services as not routed through a mediator', async () => {
      const { mockAgent, agent } = createMockAgent()
      mockAgent.dids.resolveDidDocument.mockResolvedValueOnce({ didCommServices: [] })

      await createPublicInvitationOrGetExisting(agent, publicDid, label)

      const [invitationConfig] = mockAgent.didcomm.oob.createInvitation.mock.calls[0]
      expect(invitationConfig.invitationDid).toBeUndefined()
    })

    it('returns the existing invitation without creating a new one', async () => {
      const { mockAgent, agent } = createMockAgent()
      await AsyncStorage.setItem(PUBLIC_INVITATION_ID_KEY, 'existing-invitation-id')
      mockAgent.didcomm.oob.findById.mockResolvedValueOnce({
        id: 'existing-invitation-id',
        outOfBandInvitation: { toUrl: () => 'didcomm://invite?oob=existing' },
      })

      const invitationUrl = await createPublicInvitationOrGetExisting(agent, publicDid, label)

      expect(invitationUrl).toBe('didcomm://invite?oob=existing')
      expect(mockAgent.didcomm.oob.findById).toHaveBeenCalledWith('existing-invitation-id')
      expect(mockAgent.didcomm.oob.createInvitation).not.toHaveBeenCalled()
      expect(mockAgent.dids.resolveDidDocument).not.toHaveBeenCalled()
      expect(await AsyncStorage.getItem(PUBLIC_INVITATION_ID_KEY)).toBe('existing-invitation-id')
    })
  })

  describe('createPublicInvitationWhenMediatorReady', () => {
    it('creates the invitation for the stored public DID', async () => {
      const { mockAgent, agent } = createMockAgent()
      await AsyncStorage.setItem(PUBLIC_DID_KEY, publicDid)
      mockAgent.dids.resolveDidDocument.mockResolvedValueOnce(unroutedDidDocument)

      const invitationUrl = await createPublicInvitationWhenMediatorReady(agent, label)

      expect(invitationUrl).toBe('didcomm://invite?oob=new')
      expect(mockAgent.dids.getCreatedDids).toHaveBeenCalledWith({ method: 'peer', did: publicDid })
      expect(mockAgent.dids.resolveDidDocument).toHaveBeenCalledWith(publicDid)
      const [invitationConfig] = mockAgent.didcomm.oob.createInvitation.mock.calls[0]
      expect(invitationConfig.invitationDid).toBeUndefined()
    })

    it('shares one invitation creation between concurrent calls for the same agent', async () => {
      const { mockAgent, agent, invitationRecord } = createMockAgent()
      await AsyncStorage.setItem(PUBLIC_DID_KEY, publicDid)
      let resolveInvitation: (record: typeof invitationRecord) => void = () => undefined
      mockAgent.didcomm.oob.createInvitation.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInvitation = resolve
        })
      )

      const firstCall = createPublicInvitationWhenMediatorReady(agent, label)
      const secondCall = createPublicInvitationWhenMediatorReady(agent, label)

      // Let the first call reach 'createInvitation' while the second one is still pending
      for (let i = 0; i < 50 && mockAgent.didcomm.oob.createInvitation.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      expect(mockAgent.didcomm.oob.createInvitation).toHaveBeenCalledTimes(1)
      resolveInvitation(invitationRecord)

      const [firstUrl, secondUrl] = await Promise.all([firstCall, secondCall])

      expect(firstUrl).toBe('didcomm://invite?oob=new')
      expect(secondUrl).toBe(firstUrl)
      expect(mockAgent.didcomm.oob.createInvitation).toHaveBeenCalledTimes(1)
      expect(mockAgent.dids.getCreatedDids).toHaveBeenCalledTimes(1)
      expect(await AsyncStorage.getItem(PUBLIC_INVITATION_ID_KEY)).toBe('new-invitation-id')
    })

    it('retries the creation on the next call after a failed one', async () => {
      const { mockAgent, agent } = createMockAgent()
      await AsyncStorage.setItem(PUBLIC_DID_KEY, publicDid)
      const error = new Error('Invitation creation failed')
      mockAgent.didcomm.oob.createInvitation.mockRejectedValueOnce(error)

      await expect(createPublicInvitationWhenMediatorReady(agent, label)).rejects.toBe(error)
      expect(await AsyncStorage.getItem(PUBLIC_INVITATION_ID_KEY)).toBeNull()

      const invitationUrl = await createPublicInvitationWhenMediatorReady(agent, label)

      expect(invitationUrl).toBe('didcomm://invite?oob=new')
      expect(mockAgent.didcomm.oob.createInvitation).toHaveBeenCalledTimes(2)
      expect(await AsyncStorage.getItem(PUBLIC_INVITATION_ID_KEY)).toBe('new-invitation-id')
    })
  })

  describe('trySetupMediator', () => {
    afterEach(() => {
      jest.useRealTimers()
    })

    it('runs the mediator ready callback before returning when the mediator is set up right away', async () => {
      const { agent } = createMockAgent()
      const onMediatorReady = jest.fn()

      await trySetupMediator(agent, mediatorInvitationUrl, onMediatorReady)

      expect(onMediatorReady).toHaveBeenCalledTimes(1)
    })

    it('connects to the mediator and sets it as default when there is no default mediator', async () => {
      const { mockAgent, agent } = createMockAgent({ defaultMediator: null })
      const { mediationRecipient, oob, connections } = mockAgent.didcomm
      const onMediatorReady = jest.fn()

      await trySetupMediator(agent, mediatorInvitationUrl, onMediatorReady)

      expect(oob.parseInvitation).toHaveBeenCalledWith(mediatorInvitationUrl)
      expect(oob.findByReceivedInvitationId).toHaveBeenCalledWith(mediatorOutOfBandInvitation.id)
      // Nothing to clean up from a previous attempt
      expect(connections.deleteById).not.toHaveBeenCalled()
      expect(oob.deleteById).not.toHaveBeenCalled()

      // The current default mediator must not be used to connect to the mediator
      expect(mediationRecipient.getRouting).toHaveBeenCalledWith({ useDefaultMediator: false })
      expect(oob.receiveInvitation).toHaveBeenCalledTimes(1)
      expect(oob.receiveInvitation).toHaveBeenCalledWith(mediatorOutOfBandInvitation, {
        label: '',
        alias: 'Mediator',
        routing: mediatorRouting,
      })
      expect(connections.returnWhenIsConnected).toHaveBeenCalledWith(mediatorConnectionRecord.id, {
        timeoutMs: expect.any(Number),
      })

      // Mediation is requested over the connected connection, not the one returned by 'receiveInvitation'
      expect(mediationRecipient.requestAndAwaitGrant).toHaveBeenCalledWith(
        connectedMediatorConnectionRecord,
        expect.any(Number)
      )
      expect(mediationRecipient.setDefaultMediator).toHaveBeenCalledTimes(1)
      expect(mediationRecipient.setDefaultMediator).toHaveBeenCalledWith(mediationRecord)
      expect(mediationRecipient.initiateMessagePickup).toHaveBeenCalledTimes(1)
      expect(mediationRecipient.initiateMessagePickup).toHaveBeenCalledWith(mediationRecord)

      // The mediator is set as default before message pickup starts and before the callback runs
      const setDefaultOrder = mediationRecipient.setDefaultMediator.mock.invocationCallOrder[0]
      expect(setDefaultOrder).toBeLessThan(mediationRecipient.initiateMessagePickup.mock.invocationCallOrder[0])
      expect(setDefaultOrder).toBeLessThan(onMediatorReady.mock.invocationCallOrder[0])

      expect(onMediatorReady).toHaveBeenCalledTimes(1)
      expect(mockAgent.config.logger.warn).not.toHaveBeenCalled()
    })

    it('does not connect to the mediator when the default mediator already exists', async () => {
      const { mockAgent, agent } = createMockAgent()

      await trySetupMediator(agent, mediatorInvitationUrl)

      expect(mockAgent.didcomm.oob.parseInvitation).not.toHaveBeenCalled()
      expect(mockAgent.didcomm.oob.receiveInvitation).not.toHaveBeenCalled()
      expect(mockAgent.didcomm.mediationRecipient.requestAndAwaitGrant).not.toHaveBeenCalled()
      expect(mockAgent.didcomm.mediationRecipient.setDefaultMediator).not.toHaveBeenCalled()
      expect(mockAgent.didcomm.mediationRecipient.initiateMessagePickup).not.toHaveBeenCalled()
    })

    it('deletes the leftovers of a previous failed attempt before receiving the mediator invitation', async () => {
      const { mockAgent, agent } = createMockAgent({ defaultMediator: null })
      const { oob, connections } = mockAgent.didcomm
      oob.findByReceivedInvitationId.mockResolvedValueOnce({ id: 'previous-oob-record-id' })
      connections.findAllByOutOfBandId.mockResolvedValueOnce([
        { id: 'previous-connection-id-1' },
        { id: 'previous-connection-id-2' },
      ])

      await trySetupMediator(agent, mediatorInvitationUrl)

      expect(oob.findByReceivedInvitationId).toHaveBeenCalledWith(mediatorOutOfBandInvitation.id)
      expect(connections.findAllByOutOfBandId).toHaveBeenCalledWith('previous-oob-record-id')
      expect(connections.deleteById).toHaveBeenCalledTimes(2)
      expect(connections.deleteById).toHaveBeenNthCalledWith(1, 'previous-connection-id-1')
      expect(connections.deleteById).toHaveBeenNthCalledWith(2, 'previous-connection-id-2')
      expect(oob.deleteById).toHaveBeenCalledTimes(1)
      expect(oob.deleteById).toHaveBeenCalledWith('previous-oob-record-id')

      // Cleanup happens before the invitation is received again
      const receiveOrder = oob.receiveInvitation.mock.invocationCallOrder[0]
      expect(oob.deleteById.mock.invocationCallOrder[0]).toBeLessThan(receiveOrder)
      for (const order of connections.deleteById.mock.invocationCallOrder) {
        expect(order).toBeLessThan(receiveOrder)
      }
      expect(mockAgent.didcomm.mediationRecipient.setDefaultMediator).toHaveBeenCalledWith(mediationRecord)
    })

    it.each([
      [
        'the connection times out',
        (mockAgent: ReturnType<typeof createMockAgent>['mockAgent']) =>
          mockAgent.didcomm.connections.returnWhenIsConnected.mockRejectedValueOnce(
            new Error('Timeout waiting for connection to be connected')
          ),
      ],
      [
        'the mediation grant fails',
        (mockAgent: ReturnType<typeof createMockAgent>['mockAgent']) =>
          mockAgent.didcomm.mediationRecipient.requestAndAwaitGrant.mockRejectedValueOnce(
            new Error('Mediation grant timed out')
          ),
      ],
    ])('retries the first-time mediator setup in background when %s', async (_, failFirstAttempt) => {
      jest.useFakeTimers()
      const { mockAgent, agent } = createMockAgent({ defaultMediator: null })
      const { mediationRecipient, oob, connections } = mockAgent.didcomm
      const onMediatorReady = jest.fn()
      failFirstAttempt(mockAgent)
      // The second attempt finds the out-of-band record left by the first one
      oob.findByReceivedInvitationId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'first-attempt-oob-record-id' })
      connections.findAllByOutOfBandId.mockResolvedValueOnce([{ id: mediatorConnectionRecord.id }])

      await expect(trySetupMediator(agent, mediatorInvitationUrl, onMediatorReady)).resolves.toBeUndefined()

      expect(mockAgent.config.logger.warn).toHaveBeenCalledWith('Failed to set up mediator, will retry in background', {
        error: expect.any(Error),
      })
      expect(oob.receiveInvitation).toHaveBeenCalledTimes(1)
      expect(mediationRecipient.setDefaultMediator).not.toHaveBeenCalled()
      expect(mediationRecipient.initiateMessagePickup).not.toHaveBeenCalled()
      expect(onMediatorReady).not.toHaveBeenCalled()

      await jest.advanceTimersByTimeAsync(5000)

      // The background attempt cleans up the first attempt and connects again
      expect(oob.parseInvitation).toHaveBeenCalledTimes(2)
      expect(connections.deleteById).toHaveBeenCalledWith(mediatorConnectionRecord.id)
      expect(oob.deleteById).toHaveBeenCalledWith('first-attempt-oob-record-id')
      expect(oob.receiveInvitation).toHaveBeenCalledTimes(2)
      expect(oob.receiveInvitation).toHaveBeenLastCalledWith(mediatorOutOfBandInvitation, {
        label: '',
        alias: 'Mediator',
        routing: mediatorRouting,
      })
      expect(mediationRecipient.setDefaultMediator).toHaveBeenCalledTimes(1)
      expect(mediationRecipient.setDefaultMediator).toHaveBeenCalledWith(mediationRecord)
      expect(mediationRecipient.initiateMessagePickup).toHaveBeenCalledWith(mediationRecord)
      expect(mockAgent.config.logger.info).toHaveBeenCalledWith('Mediator is set up')
      expect(onMediatorReady).toHaveBeenCalledTimes(1)

      // No further attempts or callback runs
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(oob.receiveInvitation).toHaveBeenCalledTimes(2)
      expect(mediationRecipient.setDefaultMediator).toHaveBeenCalledTimes(1)
      expect(onMediatorReady).toHaveBeenCalledTimes(1)
    })

    it('logs a mediator ready callback failure without throwing', async () => {
      const { mockAgent, agent } = createMockAgent()
      const error = new Error('Invitation creation failed')
      const onMediatorReady = jest.fn().mockRejectedValue(error)

      await expect(trySetupMediator(agent, mediatorInvitationUrl, onMediatorReady)).resolves.toBeUndefined()

      expect(onMediatorReady).toHaveBeenCalledTimes(1)
      expect(mockAgent.config.logger.error).toHaveBeenCalledWith(expect.any(String), { error })
    })

    it('runs the mediator ready callback once, after the background setup succeeds', async () => {
      jest.useFakeTimers()
      const { mockAgent, agent } = createMockAgent()
      const onMediatorReady = jest.fn()
      mockAgent.didcomm.mediationRecipient.findDefaultMediator
        .mockRejectedValueOnce(new Error('Mediator is not reachable'))
        .mockRejectedValueOnce(new Error('Mediator is not reachable'))

      await trySetupMediator(agent, mediatorInvitationUrl, onMediatorReady)

      // Startup is not blocked and no callback yet, the setup continues in background
      expect(onMediatorReady).not.toHaveBeenCalled()

      // First background attempt fails
      await jest.advanceTimersByTimeAsync(5000)
      expect(mockAgent.didcomm.mediationRecipient.findDefaultMediator).toHaveBeenCalledTimes(2)
      expect(onMediatorReady).not.toHaveBeenCalled()

      // Second background attempt (after the doubled delay) succeeds
      await jest.advanceTimersByTimeAsync(10000)
      expect(mockAgent.didcomm.mediationRecipient.findDefaultMediator).toHaveBeenCalledTimes(3)
      expect(onMediatorReady).toHaveBeenCalledTimes(1)

      // No further attempts or callback runs
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(mockAgent.didcomm.mediationRecipient.findDefaultMediator).toHaveBeenCalledTimes(3)
      expect(onMediatorReady).toHaveBeenCalledTimes(1)
    })

    it('logs a callback failure after the background setup and does not retry the setup', async () => {
      jest.useFakeTimers()
      const { mockAgent, agent } = createMockAgent()
      const error = new Error('Invitation creation failed')
      const onMediatorReady = jest.fn().mockRejectedValue(error)
      mockAgent.didcomm.mediationRecipient.findDefaultMediator.mockRejectedValueOnce(
        new Error('Mediator is not reachable')
      )

      await trySetupMediator(agent, mediatorInvitationUrl, onMediatorReady)
      await jest.advanceTimersByTimeAsync(5000)

      expect(onMediatorReady).toHaveBeenCalledTimes(1)
      expect(mockAgent.config.logger.error).toHaveBeenCalledWith(expect.any(String), { error })
      expect(mockAgent.config.logger.info).toHaveBeenCalledWith('Mediator is set up')

      // The callback failure is not treated as a mediator setup failure
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(mockAgent.didcomm.mediationRecipient.findDefaultMediator).toHaveBeenCalledTimes(2)
      expect(onMediatorReady).toHaveBeenCalledTimes(1)
    })

    it('creates the public invitation once the background setup succeeds', async () => {
      jest.useFakeTimers()
      const { mockAgent, agent } = createMockAgent()
      await AsyncStorage.setItem(PUBLIC_DID_KEY, publicDid)
      mockAgent.dids.resolveDidDocument.mockResolvedValue(unroutedDidDocument)
      mockAgent.didcomm.mediationRecipient.findDefaultMediator.mockRejectedValueOnce(
        new Error('Mediator is not reachable')
      )

      await trySetupMediator(agent, mediatorInvitationUrl, async () => {
        await createPublicInvitationWhenMediatorReady(agent, label)
      })

      expect(mockAgent.didcomm.oob.createInvitation).not.toHaveBeenCalled()
      expect(await AsyncStorage.getItem(PUBLIC_INVITATION_ID_KEY)).toBeNull()

      await jest.advanceTimersByTimeAsync(5000)

      expect(mockAgent.didcomm.oob.createInvitation).toHaveBeenCalledTimes(1)
      const [invitationConfig] = mockAgent.didcomm.oob.createInvitation.mock.calls[0]
      expect(invitationConfig.invitationDid).toBeUndefined()
      expect(await AsyncStorage.getItem(PUBLIC_INVITATION_ID_KEY)).toBe('new-invitation-id')
    })
  })
})
