import { mapRecordsSkippingFailures } from '../../src/credentials/mapRecordsSkippingFailures'

const SECRET = 'given_name=John'

describe('mapRecordsSkippingFailures', () => {
  const logger = { warn: jest.fn() }

  const records = [
    { id: 'sd-jwt', type: 'SdJwtVcRecord' },
    { id: 'old-mdoc', type: 'MdocRecord' },
    { id: 'mdoc', type: 'MdocRecord' },
    { id: 'w3c', type: 'W3cCredentialRecord' },
  ]

  it('keeps the mapped records in order and skips the ones that fail', async () => {
    const result = await mapRecordsSkippingFailures(
      records,
      async (record) => {
        if (record.id === 'old-mdoc') throw new TypeError(`Error decoding UnprotectedHeaders: ${SECRET}`)
        return record.id.toUpperCase()
      },
      logger,
      'Test'
    )

    expect(result).toEqual(['SD-JWT', 'MDOC', 'W3C'])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('Test: skipping a credential record that cannot be read', {
      recordId: 'old-mdoc',
      recordType: 'MdocRecord',
      error: 'TypeError',
    })
  })

  it('skips records whose mapper throws synchronously', async () => {
    const result = await mapRecordsSkippingFailures(
      records,
      (record) => {
        // Like reading `MdocRecord.firstCredential`, which decodes the stored mdoc in a getter.
        if (record.type === 'MdocRecord') throw new Error(SECRET)
        return record.id
      },
      logger,
      'Test'
    )

    expect(result).toEqual(['sd-jwt', 'w3c'])
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it('never logs the error message, which may contain credential content', async () => {
    await mapRecordsSkippingFailures(
      records,
      () => {
        throw new Error(SECRET)
      },
      logger,
      'Test'
    )
    await mapRecordsSkippingFailures(records, () => Promise.reject(SECRET), logger, 'Test')

    expect(logger.warn).toHaveBeenCalledTimes(2 * records.length)
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET)
    expect(logger.warn).toHaveBeenLastCalledWith(expect.any(String), {
      recordId: 'w3c',
      recordType: 'W3cCredentialRecord',
      error: 'string',
    })
  })

  it('returns an empty list when there are no records', async () => {
    await expect(mapRecordsSkippingFailures([], jest.fn(), logger, 'Test')).resolves.toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
