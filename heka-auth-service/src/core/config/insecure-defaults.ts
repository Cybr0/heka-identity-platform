import { Logger } from '@nestjs/common'

/**
 * Publicly known default values for security-sensitive settings.
 *
 * They keep local development and tests working out of the box, but anyone can read them
 * from this repository. The config classes reference them (so there is a single source of
 * truth) and `assertSecureConfiguration` checks at startup that a deployment does not rely on them.
 */
export const INSECURE_DEFAULTS = {
  JWT_SECRET: 'test',
  DB_PASSWORD: 'heka1',
} as const

export type InsecureDefaultName = keyof typeof INSECURE_DEFAULTS

/**
 * Returns the names of sensitive variables that are unset, empty or equal to their publicly known default.
 */
export function findInsecureDefaults(env: Record<string, unknown>): InsecureDefaultName[] {
  return (Object.keys(INSECURE_DEFAULTS) as InsecureDefaultName[]).filter((name) => {
    const value = env[name]
    return value === undefined || value === '' || value === INSECURE_DEFAULTS[name]
  })
}

/**
 * Warns when publicly known default values are in use, and refuses to start when `NODE_ENV=production`.
 * Called from the `validate` hook of the ConfigModule.
 */
export function assertSecureConfiguration(env: Record<string, unknown>): void {
  const names = findInsecureDefaults(env)
  if (names.length === 0) return

  const summary = `Insecure configuration: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} unset or use publicly known default values.`

  if (env.NODE_ENV === 'production') {
    throw new Error(`${summary} Set these environment variables explicitly before running in production.`)
  }

  new Logger('Config').warn(
    `${summary} This is acceptable for local development only; the service will refuse to start with NODE_ENV=production.`,
  )
}
