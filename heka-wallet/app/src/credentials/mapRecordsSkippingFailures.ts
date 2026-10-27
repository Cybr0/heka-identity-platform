interface StoredRecord {
  id: string
  type: string
}

interface WarnLogger {
  warn(message: string, data?: Record<string, unknown>): void
}

/**
 * Maps every record and leaves out the ones whose mapping fails, so that one record the wallet can no longer
 * read (for example an mdoc stored with an encoding the current Credo version cannot decode) does not hide
 * all other credentials. Results keep the order of `records`.
 *
 * A skipped record is logged with its id and type and the error name only: error messages from decoders can
 * echo parts of the credential, which must not end up in logs.
 */
export async function mapRecordsSkippingFailures<R extends StoredRecord, T>(
  records: readonly R[],
  map: (record: R) => T | Promise<T>,
  logger: WarnLogger,
  context: string
): Promise<T[]> {
  // The async wrapper turns synchronous throws (e.g. from a record getter) into rejections.
  const results = await Promise.allSettled(records.map(async (record) => map(record)))

  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [result.value]

    const record = records[index]
    logger.warn(`${context}: skipping a credential record that cannot be read`, {
      recordId: record.id,
      recordType: record.type,
      error: result.reason instanceof Error ? result.reason.name : typeof result.reason,
    })
    return []
  })
}
