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

function createMockAgent() {
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
        // Default mediator already exists, so the mediator setup succeeds without connecting
        findDefaultMediator: jest.fn().mockResolvedValue({ id: 'mediation-record-id' }),
      },
      oob: {
        createInvitation: jest.fn().mockResolvedValue(invitationRecord),
        findById: jest.fn(),
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
