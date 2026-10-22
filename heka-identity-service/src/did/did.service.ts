import type { DidDocument, DidRecord, DidResolutionResult } from '@credo-ts/core'

import { DidRepository, parseDid } from '@credo-ts/core'
import { EntityManager } from '@mikro-orm/core'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ConfigType } from '@nestjs/config'
import { Mutex } from 'async-mutex'

import { Agent, AGENT_TOKEN, TenantAgent } from 'common/agent'
import { AuthInfo, Role } from 'common/auth'
import { AuthorizationService } from 'common/authz'
import {
  DID_DEACTIVATED_TAG,
  DidRegistrar,
  DidRegistrarService,
  fragmentOf,
  isDidRecordDeactivated,
  isOwnDidDeactivated,
  UpdateDidOptions,
  VERIFICATION_RELATIONSHIPS,
} from 'common/did-registrar'
import { Wallet } from 'common/entities'
import { InjectLogger, Logger } from 'common/logger'
import { DidMethod, MAIN_DID_METHOD } from 'common/types'
import { WalletLockService } from 'common/wallet-lock'
import { getDidControllerWalletId } from 'utils/auth'
import { withTenantAgent } from 'utils/multi-tenancy'

import AgentConfig from '../config/agent'

import {
  CreateDidRequestDto,
  DEFAULT_VERIFICATION_PURPOSES,
  DidDocumentDto,
  FindDidRequestDto,
  GetDidMethodsResponseDto,
  MAX_DID_UPDATE_OPERATIONS,
  UpdateDidRequestDto,
} from './dto'

// How long an update or deactivation waits for another request on the same wallet (seconds)
const DID_OPERATION_LOCK_TIMEOUT_SECONDS = 60

// Roles that may change the DIDs of their wallet, as far as the role model is enforced. A Verifier only holds a
// did:key, which cannot change
const DID_OPERATION_ROLES = [Role.Admin, Role.OrgAdmin, Role.Issuer]

@Injectable()
export class DidService {
  // One lock per wallet, so main-DID creation for unrelated wallets doesn't wait in one queue
  private readonly mainDidMutexes = new Map<string, Mutex>()

  public constructor(
    @Inject(AGENT_TOKEN)
    private readonly agent: Agent,
    private readonly em: EntityManager,
    @InjectLogger(DidService)
    private readonly logger: Logger,
    private readonly didRegistrarService: DidRegistrarService,
    @Inject(AgentConfig.KEY)
    private readonly agentConfig: ConfigType<typeof AgentConfig>,
    private readonly authorizationService: AuthorizationService,
    private readonly walletLockService: WalletLockService,
  ) {
    this.logger.child('constructor').trace('<>')
  }

  public async find(tenantAgent: TenantAgent, req: FindDidRequestDto): Promise<DidDocumentDto[]> {
    const logger = this.logger.child('find', req)
    logger.trace('>')

    if (!req.own) {
      throw new BadRequestException('Bulk retrieval is supported for own DIDs of the user only')
    }

    const didRecords = await tenantAgent.dids.getCreatedDids({
      method: req.method,
    })

    const res = await Promise.all(
      didRecords
        .filter((record) => record.did !== this.agent.agencyConfig.indyEndorserDid) // exclude endorser DID
        .filter((record) => req.includeDeactivated || !isDidRecordDeactivated(record))
        .map(async (record) => {
          const didDocument = record.didDocument ?? (await tenantAgent.dids.resolveDidDocument(record.did))
          // Active DIDs are returned as before; a deactivated one (only on request) carries the flag
          return isDidRecordDeactivated(record)
            ? ({ ...didDocument.toJSON(), deactivated: true } as unknown as DidDocumentDto)
            : didDocument
        }),
    )

    logger.trace('<')
    return res
  }

  public async create(authInfo: AuthInfo, req: CreateDidRequestDto): Promise<DidDocumentDto> {
    /* jscpd:ignore-start */
    const logger = this.logger.child('create')
    logger.trace('>')

    const method = req.method ?? MAIN_DID_METHOD

    const run = async () => {
      // 1. `Wallet.publicDid` is the main-method DID, so only that method is limited to one per wallet.
      // The wallet is re-read so a main DID persisted by a concurrent request is observed
      const wallet = await this.em.findOneOrFail(Wallet, { id: authInfo.walletId }, { refresh: true })
      if (method === MAIN_DID_METHOD && wallet.publicDid) {
        throw new ConflictException(`The wallet already contains created public DID: ${wallet.publicDid}`)
      }

      // 2. With the role model enabled, the new DID is controlled by the DID of the same method held by the
      // controller wallet (Admin -> OrgAdmin -> Issuer), for methods that support a controller. A Verifier may only
      // create a self-controlled did:key (no ledger write), enough to prepare its wallet and sign verification
      // requests. Other roles that cannot create a public DID are rejected here as well
      let controller: string | undefined
      if (this.authorizationService.isEnforced && authInfo.role === Role.Verifier) {
        if (method !== DidMethod.Key) {
          throw new ForbiddenException(`Role '${authInfo.role}' can only create did:key DIDs, not '${method}'`)
        }
      } else if (this.authorizationService.isEnforced) {
        const didControllerWalletId = getDidControllerWalletId({ role: authInfo.role, orgId: authInfo.orgId })
        if (didControllerWalletId && this.didRegistrarService.supportsController(method)) {
          controller = await this.findCreatedDid(didControllerWalletId, method)
          if (!controller) {
            throw new UnprocessableEntityException(
              `A ${method} DID created by ${didControllerWalletId} is required in order to be set as controller but it has not been created yet`,
            )
          }
          logger.info(`DID controller: ${controller}`)
        }
      }

      // 3. Unsupported methods are rejected by the registrar
      const didDocument = await this.didRegistrarService.createDid(authInfo.tenantId, method, {
        namespace: this.agent.agencyConfig.networks[0].indyNamespace,
        controller,
      })

      // 4. The main DID is claimed in the database, so another Identity Service instance that created one at the same
      // time can't overwrite it: only the first write to an empty `public_did` succeeds
      if (method === MAIN_DID_METHOD) {
        const claimed = await this.em.nativeUpdate(
          Wallet,
          { id: wallet.id, publicDid: null },
          { publicDid: didDocument.id },
        )
        if (!claimed) {
          await this.deleteCreatedDid(authInfo.tenantId, didDocument.id)
          const { publicDid } = await this.em.findOneOrFail(Wallet, { id: wallet.id }, { refresh: true })
          throw new ConflictException(`The wallet already contains created public DID: ${publicDid}`)
        }
        wallet.publicDid = didDocument.id
      }
      await this.em.flush()
      return didDocument
    }

    // Within this instance the main-method DID check, creation and write are serialized per wallet, so concurrent
    // requests cannot both create one
    const didDocument =
      method === MAIN_DID_METHOD ? await this.runExclusiveForWallet(authInfo.walletId, run) : await run()

    const res = new DidDocumentDto(didDocument)

    logger.trace('<')
    return res
    /* jscpd:ignore-end */
  }

  /**
   * The wallet's own DID of a method, the oldest when there are several, without resolving it. The Indy endorser DID,
   * which every tenant holds, is not the wallet's own; a DID the wallet deactivated is no longer used.
   */
  public async findOwnDid(tenantAgent: TenantAgent, method: string): Promise<string | undefined> {
    const didRecords = await tenantAgent.dids.getCreatedDids({ method })
    const [oldest] = didRecords
      .filter((record) => record.did !== this.agent.agencyConfig.indyEndorserDid && !isDidRecordDeactivated(record))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    return oldest?.did
  }

  private async runExclusiveForWallet<T>(walletId: string, operation: () => Promise<T>): Promise<T> {
    let mutex = this.mainDidMutexes.get(walletId)
    if (!mutex) {
      mutex = new Mutex()
      this.mainDidMutexes.set(walletId, mutex)
    }
    try {
      return await mutex.runExclusive(operation)
    } finally {
      if (!mutex.isLocked()) {
        this.mainDidMutexes.delete(walletId)
      }
    }
  }

  /** Removes the record of a `did:key` that lost the race for `public_did`; a `did:key` has nothing on a ledger. */
  private async deleteCreatedDid(tenantId: string, did: string): Promise<void> {
    await withTenantAgent({ agent: this.agent, tenantId }, async (tenantAgent) => {
      const didRepository = tenantAgent.dependencyManager.resolve(DidRepository)
      const didRecord = await didRepository.findCreatedDid(tenantAgent.context, did)
      if (didRecord) {
        await didRepository.delete(tenantAgent.context, didRecord)
      }
    })
    this.logger.child('deleteCreatedDid').info(`Deleted ${did}: another request set the wallet's main DID first`)
  }

  private async findCreatedDid(walletId: string, method: string): Promise<string | undefined> {
    const wallet = await this.em.findOne(Wallet, { id: walletId })
    if (!wallet) {
      return undefined
    }
    // A deactivated DID can no longer control anything: the oldest active one is the controller
    return await withTenantAgent({ agent: this.agent, tenantId: wallet.tenantId }, (tenantAgent) =>
      this.findOwnDid(tenantAgent, method),
    )
  }

  public async get(tenantAgent: TenantAgent, did: string): Promise<DidDocumentDto> {
    const logger = this.logger.child('get')
    logger.trace('>')

    const didResolutionResult = await tenantAgent.dids.resolve(did)

    logger.info(`DID Resolution result: ${JSON.stringify(didResolutionResult)}`)

    const {
      didDocument,
      didResolutionMetadata: { error, message },
    } = didResolutionResult

    if (!didDocument) {
      switch (error) {
        case 'notFound':
          throw new NotFoundException(`DID not found`)
        case 'unsupportedDidMethod':
        case 'invalidDid':
          throw new BadRequestException(`Unable to resolve DID document for DID '${did}': ${error} ${message}`)
        default:
          throw new InternalServerErrorException(`Unable to resolve DID document for DID '${did}': ${error} ${message}`)
      }
    }

    // A DID of the wallet is often resolved from its record, which carries no resolution metadata
    const deactivated =
      didResolutionResult.didDocumentMetadata.deactivated === true || (await isOwnDidDeactivated(tenantAgent, did))
    const res = new DidDocumentDto(didDocument, { deactivated })

    logger.trace('<')
    return res
  }

  /**
   * Updates a DID of the caller's wallet: adds or removes services and Ed25519 verification methods (keys generated in
   * the wallet's KMS). Only the wallet that created the DID holds its keys, so only that wallet can change it.
   */
  public async update(
    authInfo: AuthInfo,
    tenantAgent: TenantAgent,
    did: string,
    req: UpdateDidRequestDto,
  ): Promise<DidDocumentDto> {
    const logger = this.logger.child('update', { did })
    logger.trace('>')

    const operationCount =
      (req.addServices?.length ?? 0) +
      (req.removeServices?.length ?? 0) +
      (req.addVerificationMethods?.length ?? 0) +
      (req.removeVerificationMethods?.length ?? 0)
    if (operationCount < 1 || operationCount > MAX_DID_UPDATE_OPERATIONS) {
      throw new BadRequestException(
        `A DID update must contain between 1 and ${MAX_DID_UPDATE_OPERATIONS} operations (addServices, removeServices, addVerificationMethods, removeVerificationMethods)`,
      )
    }

    const res = await this.walletLockService.runExclusive(
      authInfo.walletId,
      DID_OPERATION_LOCK_TIMEOUT_SECONDS,
      async () => {
        const { didRecord, method } = await this.findOwnDidRecord(authInfo, tenantAgent, did)
        const didRegistrar = this.didRegistrarService.getUpdatingDidRegistrar(method, 'update')

        if (isDidRecordDeactivated(didRecord)) {
          throw new ConflictException('DID is deactivated')
        }
        // The ledger is the reference: the operations are checked against its document, and it may know of a
        // deactivation the wallet does not
        const resolution = await this.resolveFromLedger(tenantAgent, did)
        if (resolution.didDocumentMetadata.deactivated) {
          await this.markDeactivated(tenantAgent, didRecord)
          throw new ConflictException('DID is deactivated')
        }
        // Without the ledger document neither the operations nor a deactivation can be checked; the wallet's copy may
        // be stale, so it is no substitute. Resolvers report transport errors as `notFound` too, so no detail is given
        const currentDidDocument = resolution.didDocument
        if (!currentDidDocument) {
          logger.warn(`Ledger resolution failed: ${resolution.didResolutionMetadata.error ?? 'unknown error'}`)
          throw new ServiceUnavailableException('Unable to read the current DID document from its ledger; retry later')
        }

        const options = this.toUpdateOptions(did, currentDidDocument, req, didRegistrar)
        logger.info(
          `Updating DID: +${options.addServices.length}/-${options.removeServices.length} services, +${options.addVerificationMethods.length}/-${options.removeVerificationMethods.length} verification methods`,
        )
        return new DidDocumentDto(await this.didRegistrarService.updateDid(tenantAgent, method, options))
      },
    )

    logger.trace('<')
    return res
  }

  /**
   * Deactivates a DID of the caller's wallet, irreversibly. A DID that is already deactivated is returned as is, without
   * a ledger write. The keys stay in the wallet: AnonCreds credentials issued with the DID remain revocable.
   *
   * `Wallet.publicDid` is a did:key (`MAIN_DID_METHOD`), which cannot be deactivated. Should the main method ever be one
   * that can, deactivating the main DID must also clear `Wallet.publicDid`.
   */
  public async deactivate(authInfo: AuthInfo, tenantAgent: TenantAgent, did: string): Promise<DidDocumentDto> {
    const logger = this.logger.child('deactivate', { did })
    logger.trace('>')

    const res = await this.walletLockService.runExclusive(
      authInfo.walletId,
      DID_OPERATION_LOCK_TIMEOUT_SECONDS,
      async () => {
        const { didRecord, method } = await this.findOwnDidRecord(authInfo, tenantAgent, did)
        this.didRegistrarService.getUpdatingDidRegistrar(method, 'deactivate')

        if (isDidRecordDeactivated(didRecord)) {
          return new DidDocumentDto(await this.documentOf(tenantAgent, didRecord), { deactivated: true })
        }
        // A second deactivation would be rejected by some ledgers (did:indybesu), so it is not sent
        const resolution = await this.resolveFromLedger(tenantAgent, did)
        if (resolution.didDocumentMetadata.deactivated) {
          await this.markDeactivated(tenantAgent, didRecord)
          return new DidDocumentDto(resolution.didDocument ?? (await this.documentOf(tenantAgent, didRecord)), {
            deactivated: true,
          })
        }

        const didDocument = await this.didRegistrarService.deactivateDid(tenantAgent, method, did)
        // The registrar updated the record (its document) in the meantime
        const [deactivatedRecord] = await tenantAgent.dids.getCreatedDids({ did })
        await this.markDeactivated(tenantAgent, deactivatedRecord ?? didRecord)
        logger.info('Deactivated DID')
        return new DidDocumentDto(didDocument, { deactivated: true })
      },
    )

    logger.trace('<')
    return res
  }

  public getMethods(): GetDidMethodsResponseDto {
    const logger = this.logger.child('getMethods')
    logger.trace('>')

    const capabilities = Object.fromEntries(
      this.agentConfig.didMethods.map((method) => [
        method,
        {
          update: this.didRegistrarService.supportsUpdate(method),
          deactivate: this.didRegistrarService.supportsDeactivate(method),
          controller: this.didRegistrarService.supportsController(method),
        },
      ]),
    )
    const res = new GetDidMethodsResponseDto(this.agentConfig.didMethods, capabilities)

    logger.trace('<')
    return res
  }

  /**
   * The record of a DID created by the caller's wallet, after the checks every update and deactivation share: the
   * caller's role, the shared Indy endorser DID, and that the DID is the wallet's own (404 otherwise: another tenant's
   * DID or an external one).
   */
  private async findOwnDidRecord(
    authInfo: AuthInfo,
    tenantAgent: TenantAgent,
    did: string,
  ): Promise<{ didRecord: DidRecord; method: string }> {
    if (this.authorizationService.isEnforced && !DID_OPERATION_ROLES.includes(authInfo.role)) {
      throw new ForbiddenException(`Role '${authInfo.role}' cannot update or deactivate DIDs`)
    }
    if (did === this.agent.agencyConfig.indyEndorserDid) {
      throw new ForbiddenException('The Indy endorser DID is shared by the platform and cannot be changed')
    }
    const [didRecord] = await tenantAgent.dids.getCreatedDids({ did })
    if (!didRecord) {
      throw new NotFoundException('DID not found in this wallet')
    }
    return { didRecord, method: parseDid(didRecord.did).method }
  }

  /** The DID as its ledger has it now, not from a cache or the wallet's own record. */
  private async resolveFromLedger(tenantAgent: TenantAgent, did: string): Promise<DidResolutionResult> {
    return await tenantAgent.dids.resolve(did, { useCache: false, useLocalCreatedDidRecord: false })
  }

  private async documentOf(tenantAgent: TenantAgent, didRecord: DidRecord): Promise<DidDocument> {
    return didRecord.didDocument ?? (await tenantAgent.dids.resolveDidDocument(didRecord.did))
  }

  private async markDeactivated(tenantAgent: TenantAgent, didRecord: DidRecord): Promise<void> {
    didRecord.setTag(DID_DEACTIVATED_TAG, true)
    await tenantAgent.dependencyManager.resolve(DidRepository).update(tenantAgent.context, didRecord)
  }

  /**
   * Checks the requested operations against the current document and resolves them to the registrar's options. Each
   * failure is a 422: an added id that exists, an id to remove that does not, or the key that controls the DID.
   */
  private toUpdateOptions(
    did: string,
    didDocument: DidDocument,
    req: UpdateDidRequestDto,
    didRegistrar: DidRegistrar,
  ): UpdateDidOptions {
    const protectedFragment = didRegistrar.protectedKeyFragment?.toLowerCase()
    const named = [
      ...(req.addServices ?? []).map(({ id }) => id),
      ...(req.removeServices ?? []),
      ...(req.addVerificationMethods ?? []).flatMap(({ id }) => (id ? [id] : [])),
      ...(req.removeVerificationMethods ?? []),
    ]
    const protectedName = named.find((fragment) => fragment.toLowerCase() === protectedFragment)
    if (protectedName) {
      throw new UnprocessableEntityException(`${protectedName} is the key that controls the DID and cannot be changed`)
    }

    const serviceIds = new Set((didDocument.service ?? []).map(({ id }) => fragmentOf(id)))
    const verificationMethodIds = new Set((didDocument.verificationMethod ?? []).map(({ id }) => fragmentOf(id)))
    // Fragments in use anywhere in the document, compared case-insensitively
    const usedIds = new Set(
      [
        ...serviceIds,
        ...verificationMethodIds,
        ...VERIFICATION_RELATIONSHIPS.flatMap((relationship) =>
          (didDocument[relationship] ?? []).map((entry) => fragmentOf(typeof entry === 'string' ? entry : entry.id)),
        ),
      ].map((id) => id.toLowerCase()),
    )

    const assertRemovable = (ids: string[], existing: Set<string>, kind: string) => {
      ids.forEach((id, index) => {
        if (!existing.has(id)) {
          throw new UnprocessableEntityException(`${kind} ${id} does not exist in the DID document`)
        }
        if (ids.indexOf(id) !== index) {
          throw new UnprocessableEntityException(`${kind} ${id} is named more than once`)
        }
      })
    }
    assertRemovable(req.removeServices ?? [], serviceIds, 'Service')
    assertRemovable(req.removeVerificationMethods ?? [], verificationMethodIds, 'Verification method')

    // Removed ids stay in use: some ledgers apply all operations to the document before the update
    const claim = (id: string) => {
      if (usedIds.has(id.toLowerCase())) {
        throw new UnprocessableEntityException(`${id} already exists in the DID document`)
      }
      usedIds.add(id.toLowerCase())
    }
    ;(req.addServices ?? []).forEach(({ id }) => claim(id))
    ;(req.addVerificationMethods ?? []).forEach(({ id }) => id && claim(id))
    const nextKeyId = () => {
      let n = 1
      while (usedIds.has(`#key-${n}`)) n++
      claim(`#key-${n}`)
      return `#key-${n}`
    }

    return {
      did,
      currentDidDocument: didDocument,
      addServices: (req.addServices ?? []).map(({ id, type, serviceEndpoint }) => ({ id, type, serviceEndpoint })),
      removeServices: req.removeServices ?? [],
      addVerificationMethods: (req.addVerificationMethods ?? []).map(({ id, purposes }) => ({
        id: id ?? nextKeyId(),
        purposes: [...new Set(purposes ?? DEFAULT_VERIFICATION_PURPOSES)],
      })),
      removeVerificationMethods: req.removeVerificationMethods ?? [],
    }
  }
}
