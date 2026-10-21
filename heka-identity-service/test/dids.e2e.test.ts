import { Server } from 'net'

import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver, SchemaGenerator } from '@mikro-orm/postgresql'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'

import { DID_PATTERN } from 'src/__tests__/constants'
import { Role } from 'src/common/auth'
import { uuid } from 'src/utils/misc'

import { initializeMikroOrm, startTestApp } from './helpers'
import { createAuthToken } from './helpers/jwt'

const indyBesuE2E = process.env.INDY_BESU_E2E === 'true'
const INDY_BESU_DID_PATTERN = '^did:indybesu:testnet:0x[0-9a-fA-F]{40}$'

describe('E2E public DIDs creation', () => {
  let ormSchemaGenerator: SchemaGenerator
  let orm: MikroORM<PostgreSqlDriver>

  let nestApp: INestApplication
  let app: Server

  beforeAll(async () => {
    orm = await initializeMikroOrm()
    ormSchemaGenerator = orm.schema
  })

  beforeEach(async () => {
    await ormSchemaGenerator.refresh()

    nestApp = await startTestApp({ roleModelEnabled: true })
    app = nestApp.getHttpServer() as Server
  })

  afterEach(async () => {
    await nestApp.close()
  })

  afterAll(async () => {
    await ormSchemaGenerator.clear()
    await orm.close(true)
  })

  const postDid = (token: string, method?: string) =>
    request(app)
      .post('/dids')
      .send(method ? { method } : {})
      .auth(token, { type: 'bearer' })

  test('only one main-method (key) DID per wallet; other methods are not limited', async () => {
    const firstAdminToken = await createAuthToken(uuid(), Role.Admin)
    const secondAdminToken = await createAuthToken(uuid(), Role.Admin)

    expect((await postDid(firstAdminToken)).status).toBe(201)
    // Every Admin acts in the shared Administration wallet, which already has its main DID
    expect((await postDid(secondAdminToken)).status).toBe(409)
    expect((await postDid(secondAdminToken, 'indy')).status).toBe(201)
  })

  test('roles other than Admin, OrgAdmin, Issuer and Verifier cannot create a DID', async () => {
    const orgId = uuid()
    for (const token of [
      await createAuthToken(uuid(), Role.OrgManager, orgId),
      await createAuthToken(uuid(), Role.OrgMember, orgId),
      await createAuthToken(uuid(), Role.User),
    ]) {
      expect((await postDid(token)).status).toBe(403)
    }
  })

  test('a Verifier can create only a did:key', async () => {
    const verifierToken = await createAuthToken(uuid(), Role.Verifier, uuid())

    expect((await postDid(verifierToken, 'hedera')).status).toBe(403)
    expect((await postDid(verifierToken, 'indy')).status).toBe(403)
    expect((await postDid(verifierToken)).status).toBe(201)
  })

  test('a did:key cannot have another controller, so it does not wait for the controller wallet', async () => {
    const orgAdminToken = await createAuthToken(uuid(), Role.OrgAdmin, uuid())

    expect((await postDid(orgAdminToken)).status).toBe(201)
  })

  test('a did:hedera is controlled by the hedera DID of its controller wallet (Admin -> OrgAdmin -> Issuer)', async () => {
    const orgId = uuid()
    const adminToken = await createAuthToken(uuid(), Role.Admin)
    const orgAdminToken = await createAuthToken(uuid(), Role.OrgAdmin, orgId)
    const issuerToken = await createAuthToken(uuid(), Role.Issuer, orgId)

    const resolveController = async (token: string, did: string) => {
      const response = await request(app).get(`/dids/${did}`).auth(token, { type: 'bearer' })
      expect(response.status).toBe(200)
      return response.body.controller as string | string[] | undefined
    }

    // The controller must have a DID of the same method first
    expect((await postDid(orgAdminToken, 'hedera')).status).toBe(422)
    expect((await postDid(issuerToken, 'hedera')).status).toBe(422)

    const adminResponse = await postDid(adminToken, 'hedera')
    expect(adminResponse.status).toBe(201)
    const adminDid = adminResponse.body.id as string
    expect((await postDid(issuerToken, 'hedera')).status).toBe(422)

    const orgAdminResponse = await postDid(orgAdminToken, 'hedera')
    expect(orgAdminResponse.status).toBe(201)
    const orgAdminDid = orgAdminResponse.body.id as string
    expect(orgAdminResponse.body.controller).toEqual(adminDid)
    // The controller is recorded on the ledger, not only in the local DID record
    expect(await resolveController(issuerToken, orgAdminDid)).toEqual(adminDid)
    // The organization still signs with its own DID: it registers an AnonCreds schema on the ledger
    const schemaResponse = await request(app)
      .post('/schemas')
      .auth(orgAdminToken, { type: 'bearer' })
      .send({ issuerId: orgAdminDid, name: 'Diploma', version: '1.0', attrNames: ['name'] })
    expect(schemaResponse.status).toBe(201)

    const issuerResponse = await postDid(issuerToken, 'hedera')
    expect(issuerResponse.status).toBe(201)
    expect(issuerResponse.body.controller).toEqual(orgAdminDid)
    expect(await resolveController(issuerToken, issuerResponse.body.id as string)).toEqual(orgAdminDid)
  })

  async function testDidCreation(testCase: { method: string; expected: string }) {
    const firstAdminId = uuid()
    const firstAdminAuthToken = await createAuthToken(firstAdminId, Role.Admin)

    const postDidResponse = await request(app)
      .post('/dids')
      .send({ method: testCase.method })
      .auth(firstAdminAuthToken, { type: 'bearer' })

    expect(postDidResponse.status).toBe(201)
    expect(postDidResponse.body).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(testCase.expected),
      }),
    )
    return postDidResponse.body.id as string
  }

  test('did:key create', async () => {
    await testDidCreation({
      method: 'key',
      expected: `^did:key:`,
    })
  })

  test('did:indy create', async () => {
    await testDidCreation({
      method: 'indy',
      expected: `^did:indy:bcovrin:test:${DID_PATTERN}`,
    })
  })

  test('did:hedera create', async () => {
    await testDidCreation({
      method: 'hedera',
      expected: `^did:hedera:`,
    })
  })

  // Needs a local Indy-Besu network: INDY_BESU_E2E=true (see docs/setup.md, "Local Indy-Besu network")
  test.skipIf(!indyBesuE2E)('did:indybesu create', async () => {
    const did = await testDidCreation({
      method: 'indybesu',
      expected: INDY_BESU_DID_PATTERN,
    })

    // Resolved from the ledger: the DID's own secp256k1 key comes first
    const adminToken = await createAuthToken(uuid(), Role.Admin)
    const response = await request(app).get(`/dids/${did}`).auth(adminToken, { type: 'bearer' })
    expect(response.status).toBe(200)
    expect(response.body.verificationMethod[0]).toEqual(
      expect.objectContaining({ id: `${did}#KEY-1`, type: 'EcdsaSecp256k1VerificationKey2019' }),
    )
  })
})
