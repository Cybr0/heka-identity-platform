import { registerCredentials } from '@animo-id/expo-digital-credentials-api'
import { Platform } from 'react-native'

import { dcApiRegisterCredentials } from '../../src/credentials/dcApi/registerCredentials'
import { HekaWalletAgent } from '../../src/utils/agent'

jest.mock('@animo-id/expo-digital-credentials-api', () => ({ registerCredentials: jest.fn() }))
jest.mock('../../src/credentials/mappers/credential', () => ({
  mapCredentialRecord: jest.fn(async () => ({ display: { name: 'Mobile driving licence', issuer: { name: 'Heka' } } })),
}))

const mockRegisterCredentials = registerCredentials as jest.MockedFunction<typeof registerCredentials>

const readableMdoc = {
  id: 'mdoc',
  type: 'MdocRecord',
  firstCredential: {
    docType: 'org.iso.18013.5.1.mDL',
    issuerSignedNamespaces: { 'org.iso.18013.5.1': { given_name: 'John', age_over_18: true } },
  },
}

// An mdoc stored by an older Credo version: decoding it in the `firstCredential` getter throws.
const unreadableMdoc = {
  id: 'old-mdoc',
  type: 'MdocRecord',
  get firstCredential(): never {
    throw new Error('Error decoding UnprotectedHeaders: Expected Uint8Array, received string at "KeyId (4)"')
  },
}

const sdJwtVc = {
  id: 'sd-jwt',
  type: 'SdJwtVcRecord',
  getTags: () => ({ vct: 'https://example.com/vct' }),
  firstCredential: { prettyClaims: { vct: 'https://example.com/vct', first_name: 'John' } },
}

function createAgent() {
  const logger = { trace: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const agent = {
    config: { logger },
    mdoc: { getAll: jest.fn(async () => [unreadableMdoc, readableMdoc]) },
    sdJwtVc: { getAll: jest.fn(async () => [sdJwtVc]) },
  }
  return { agent: agent as unknown as HekaWalletAgent, logger }
}

describe('dcApiRegisterCredentials', () => {
  const originalOs = Platform.OS

  beforeAll(() => {
    Platform.OS = 'android'
  })

  afterAll(() => {
    Platform.OS = originalOs
  })

  it('registers the readable credentials when one mdoc record cannot be read', async () => {
    const { agent, logger } = createAgent()

    await dcApiRegisterCredentials(agent)

    expect(mockRegisterCredentials).toHaveBeenCalledTimes(1)
    const { credentials } = mockRegisterCredentials.mock.calls[0][0]
    expect(credentials.map((credential) => credential.id)).toEqual(['mdoc', 'sd-jwt'])
    expect(credentials[0]).toMatchObject({
      credential: {
        format: 'mso_mdoc',
        doctype: 'org.iso.18013.5.1.mDL',
        namespaces: { 'org.iso.18013.5.1': { given_name: 'John', age_over_18: true } },
      },
      display: { title: 'Mobile driving licence', subtitle: 'Issued by Heka' },
    })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipping a credential record'), {
      recordId: 'old-mdoc',
      recordType: 'MdocRecord',
      error: 'Error',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })
})
