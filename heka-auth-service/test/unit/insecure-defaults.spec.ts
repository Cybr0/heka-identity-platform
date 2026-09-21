import { Logger } from '@nestjs/common'

import { validate } from '../../src/core/config/config.type'
import { dbConfigDefaults } from '../../src/core/config/configs/db.config'
import { jwtConfigDefaults } from '../../src/core/config/configs/jwt.config'
import {
  assertSecureConfiguration,
  findInsecureDefaults,
  INSECURE_DEFAULTS,
} from '../../src/core/config/insecure-defaults'

const secureEnv: Record<string, string> = {
  JWT_SECRET: 'a-long-random-secret-that-is-not-the-default',
  DB_PASSWORD: 'custom-db-password',
}

describe('insecure defaults', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('config defaults reference the single source of truth', () => {
    expect(jwtConfigDefaults.secret).toBe(INSECURE_DEFAULTS.JWT_SECRET)
    expect(dbConfigDefaults.password).toBe(INSECURE_DEFAULTS.DB_PASSWORD)
  })

  describe('findInsecureDefaults', () => {
    it('returns nothing when every sensitive variable has a custom value', () => {
      expect(findInsecureDefaults(secureEnv)).toEqual([])
    })

    it.each(['JWT_SECRET', 'DB_PASSWORD'] as const)(
      'flags %s when unset, empty or equal to the known default',
      (name) => {
        const withoutVar = { ...secureEnv }
        delete withoutVar[name]
        expect(findInsecureDefaults(withoutVar)).toEqual([name])
        expect(findInsecureDefaults({ ...secureEnv, [name]: '' })).toEqual([name])
        expect(findInsecureDefaults({ ...secureEnv, [name]: INSECURE_DEFAULTS[name] })).toEqual([name])
      },
    )

    it('flags both variables when the environment is empty', () => {
      expect(findInsecureDefaults({})).toEqual(['JWT_SECRET', 'DB_PASSWORD'])
    })
  })

  describe('assertSecureConfiguration', () => {
    it('does nothing when the configuration is secure', () => {
      expect(() => assertSecureConfiguration(secureEnv)).not.toThrow()
      expect(() => assertSecureConfiguration({ ...secureEnv, NODE_ENV: 'production' })).not.toThrow()
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('throws in production and names every insecure variable', () => {
      const env = { NODE_ENV: 'production', JWT_SECRET: 'test', DB_PASSWORD: 'heka1' }

      expect(() => assertSecureConfiguration(env)).toThrow(/JWT_SECRET, DB_PASSWORD/)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it.each([undefined, 'development', 'test'])('only warns outside production (NODE_ENV=%s)', (nodeEnv) => {
      const env: Record<string, unknown> = { ...secureEnv, JWT_SECRET: 'test' }
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv

      expect(() => assertSecureConfiguration(env)).not.toThrow()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/JWT_SECRET is unset/))
    })
  })

  describe('validate', () => {
    // `DEMO_USER` has no default and is required by the existing class-validator rules
    const requiredEnv = { DEMO_USER: 'demo' }

    it('returns the config and warns when defaults are used outside production', () => {
      const config = validate(requiredEnv)

      expect(config.jwt.secret).toBe(INSECURE_DEFAULTS.JWT_SECRET)
      expect(config.db.password).toBe(INSECURE_DEFAULTS.DB_PASSWORD)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('returns the config without warning when secrets are configured', () => {
      const config = validate({ ...requiredEnv, ...secureEnv, NODE_ENV: 'production' })

      expect(config.jwt.secret).toBe(secureEnv.JWT_SECRET)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('throws in production when defaults are used', () => {
      expect(() => validate({ ...requiredEnv, NODE_ENV: 'production', JWT_SECRET: 'test' })).toThrow(
        /JWT_SECRET, DB_PASSWORD/,
      )
    })

    it('still reports class-validator errors first', () => {
      expect(() => validate({ ...requiredEnv, ...secureEnv, LOG_LEVEL: 'bogus' })).toThrow(/level/)
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})
