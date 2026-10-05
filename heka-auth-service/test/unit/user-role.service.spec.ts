import { ForbiddenException, NotFoundException } from '@nestjs/common'

import { type User, UserRole } from '../../src/core/database/entities/user.entity'
import type { UserRepository } from '../../src/core/database/repositories'
import { ORGANIZATION_ROLES, UserRoleService } from '../../src/user/user-role.service'

function createUser(id: string, role: UserRole): User {
  return { id, name: `${role.toLowerCase()}-${id}`, role } as unknown as User
}

describe('UserRoleService', () => {
  const admin = createUser('admin-1', UserRole.Admin)
  const orgAdmin = createUser('org-admin-1', UserRole.OrgAdmin)

  let service: UserRoleService
  let userRepository: {
    find: ReturnType<typeof vi.fn>
    findOne: ReturnType<typeof vi.fn>
    persistAndFlush: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    userRepository = { find: vi.fn().mockResolvedValue([]), findOne: vi.fn(), persistAndFlush: vi.fn() }
    service = new UserRoleService(userRepository as unknown as UserRepository)
  })

  describe('list', () => {
    it('lists every user for an Admin', async () => {
      userRepository.find.mockResolvedValue([admin, orgAdmin])

      const result = await service.list(admin)

      expect(userRepository.find).toHaveBeenCalledWith(
        { role: { $in: Object.values(UserRole) } },
        { orderBy: { name: 'asc' } },
      )
      expect(result.items).toEqual([
        { id: 'admin-1', name: admin.name, role: UserRole.Admin },
        { id: 'org-admin-1', name: orgAdmin.name, role: UserRole.OrgAdmin },
      ])
    })

    it('lists organization members and users outside the organization for an OrgAdmin', async () => {
      await service.list(orgAdmin)

      expect(userRepository.find).toHaveBeenCalledWith(
        { role: { $in: [...ORGANIZATION_ROLES, UserRole.User] } },
        { orderBy: { name: 'asc' } },
      )
    })

    it.each([UserRole.OrgManager, UserRole.OrgMember, UserRole.Issuer, UserRole.Verifier, UserRole.User])(
      'forbids a %s',
      async (role) => {
        await expect(service.list(createUser('sender', role))).rejects.toThrow(ForbiddenException)
        expect(userRepository.find).not.toHaveBeenCalled()
      },
    )
  })

  describe('updateRole', () => {
    it.each(Object.values(UserRole))('lets an Admin assign the %s role', async (role) => {
      const user = createUser('user-1', UserRole.User)
      userRepository.findOne.mockResolvedValue(user)

      const result = await service.updateRole(admin, 'user-1', { role })

      expect(user.role).toBe(role)
      expect(userRepository.persistAndFlush).toHaveBeenCalledWith(user)
      expect(result).toEqual({ id: 'user-1', name: user.name, role })
    })

    it.each(ORGANIZATION_ROLES)(
      'lets an OrgAdmin assign the %s role to a user outside the organization',
      async (role) => {
        const user = createUser('user-1', UserRole.User)
        userRepository.findOne.mockResolvedValue(user)

        await service.updateRole(orgAdmin, 'user-1', { role })

        expect(user.role).toBe(role)
      },
    )

    it.each([UserRole.Admin, UserRole.User])('forbids an OrgAdmin to assign the %s role', async (role) => {
      const user = createUser('user-1', UserRole.Issuer)
      userRepository.findOne.mockResolvedValue(user)

      await expect(service.updateRole(orgAdmin, 'user-1', { role })).rejects.toThrow(ForbiddenException)
      expect(user.role).toBe(UserRole.Issuer)
      expect(userRepository.persistAndFlush).not.toHaveBeenCalled()
    })

    it('hides an Admin from an OrgAdmin', async () => {
      userRepository.findOne.mockResolvedValue(createUser('admin-2', UserRole.Admin))

      await expect(service.updateRole(orgAdmin, 'admin-2', { role: UserRole.OrgMember })).rejects.toThrow(
        NotFoundException,
      )
      expect(userRepository.persistAndFlush).not.toHaveBeenCalled()
    })

    it('returns 404 for an unknown user', async () => {
      userRepository.findOne.mockResolvedValue(null)

      await expect(service.updateRole(admin, 'missing', { role: UserRole.Issuer })).rejects.toThrow(NotFoundException)
    })

    it.each([admin, orgAdmin])('forbids changing your own role ($role)', async (sender) => {
      await expect(service.updateRole(sender, sender.id, { role: UserRole.Issuer })).rejects.toThrow(ForbiddenException)
      expect(userRepository.findOne).not.toHaveBeenCalled()
    })

    it.each([UserRole.OrgManager, UserRole.Issuer, UserRole.User])('forbids a %s', async (role) => {
      await expect(service.updateRole(createUser('sender', role), 'user-1', { role: UserRole.Issuer })).rejects.toThrow(
        ForbiddenException,
      )
      expect(userRepository.findOne).not.toHaveBeenCalled()
    })
  })
})
