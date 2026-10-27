import { renderHook, waitFor } from '@testing-library/react-native'

import { mapCredentialRecord } from '../../src/credentials/mappers'
import { useCredentials } from '../../src/credentials/useCredentials'

// Stable references: the hook re-runs its loader whenever these change.
const mockLogger = { warn: jest.fn(), error: jest.fn() }
const mockAgent = { isInitialized: true, config: { logger: mockLogger } }
const mockW3cRecords = [{ id: 'w3c', type: 'W3cCredentialRecord', createdAt: new Date('2026-01-01') }]
const mockSdJwtRecords = [{ id: 'sd-jwt', type: 'SdJwtVcRecord', createdAt: new Date('2026-01-03') }]
const mockMdocRecords = [
  // Stored by an older Credo version; reading it throws in the current one.
  { id: 'old-mdoc', type: 'MdocRecord', createdAt: new Date('2026-01-04') },
  { id: 'mdoc', type: 'MdocRecord', createdAt: new Date('2026-01-02') },
]
const mockExchangeRecords: unknown[] = []
const mockConfig = { credentialHideList: [] }
const mockStore = { preferences: { developerModeEnabled: false } }

jest.mock('@bifold/core', () => ({
  TOKENS: { CONFIG: 'CONFIG' },
  useServices: () => [mockConfig],
  useStore: () => [mockStore],
}))
jest.mock('@bifold/react-hooks', () => ({ useCredentialByState: () => mockExchangeRecords }))
jest.mock('@credo-ts/anoncreds', () => ({ AnonCredsCredentialMetadataKey: '_anoncreds/credential' }))
jest.mock('@credo-ts/didcomm', () => ({
  DidCommCredentialState: { CredentialReceived: 'credential-received', Done: 'done' },
}))
jest.mock('@heka-wallet/shared', () => ({ usePrevious: () => undefined }))
jest.mock('../../src/utils/agent', () => ({ useHekaAgent: () => ({ agent: mockAgent }) }))
jest.mock('../../src/contexts', () => ({
  useW3cCredentialRecords: () => ({ w3cCredentialRecords: mockW3cRecords, isLoading: false }),
  useSdJwtVcRecords: () => ({ sdJwtVcRecords: mockSdJwtRecords, isLoading: false }),
  useMdocRecords: () => ({ mdocCredentialRecords: mockMdocRecords, isLoading: false }),
}))
jest.mock('../../src/credentials/mappers', () => ({ mapCredentialRecord: jest.fn() }))

const mockMapCredentialRecord = mapCredentialRecord as jest.MockedFunction<typeof mapCredentialRecord>

describe('useCredentials', () => {
  beforeEach(() => {
    mockMapCredentialRecord.mockImplementation(async (record) => {
      if (record.id === 'old-mdoc') {
        throw new Error('Error decoding UnprotectedHeaders: Expected Uint8Array, received string at "KeyId (4)"')
      }
      return { id: record.id } as Awaited<ReturnType<typeof mapCredentialRecord>>
    })
  })

  it('lists the readable credentials when one record cannot be read', async () => {
    const { result } = renderHook(() => useCredentials())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.credentials.map((credential) => credential.id)).toEqual(['sd-jwt', 'mdoc', 'w3c'])
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('skipping a credential record'), {
      recordId: 'old-mdoc',
      recordType: 'MdocRecord',
      error: 'Error',
    })
    expect(mockLogger.error).not.toHaveBeenCalled()
  })
})
