import { User, UserRole } from '@core/database'
import { UserRepository } from '@core/database/repositories'
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'

import { ListUsersResponse, UpdateUserRoleRequest, UserRoleItem } from './dto'

// Roles within the organization configured by `ORG_ID`
export const ORGANIZATION_ROLES: readonly UserRole[] = [
  UserRole.OrgAdmin,
  UserRole.OrgManager,
  UserRole.OrgMember,
  UserRole.Issuer,
  UserRole.Verifier,
]

/**
 * Role assignment. An `Admin` assigns any role. An `OrgAdmin` assigns organization roles, to organization members
 * and to users who are not in the organization yet. Nobody changes their own role, so the last `Admin` stays.
 */
@Injectable()
export class UserRoleService {
  public constructor(private readonly userRepository: UserRepository) {}

  public async list(sender: User): Promise<ListUsersResponse> {
    const users = await this.userRepository.find(
      { role: { $in: this.manageableRoles(sender) } },
      { orderBy: { name: 'asc' } },
    )
    return new ListUsersResponse(users.map((user) => new UserRoleItem(user)))
  }

  public async updateRole(sender: User, userId: string, data: UpdateUserRoleRequest): Promise<UserRoleItem> {
    const manageableRoles = this.manageableRoles(sender)

    if (sender.id === userId) {
      throw new ForbiddenException('Users cannot change their own role')
    }

    const user = await this.userRepository.findOne({ id: userId })
    if (!user || !manageableRoles.includes(user.role)) {
      throw new NotFoundException(`User ${userId} not found`)
    }

    if (!this.assignableRoles(sender).includes(data.role)) {
      throw new ForbiddenException(`Role '${sender.role}' cannot assign the '${data.role}' role`)
    }

    user.role = data.role
    await this.userRepository.persistAndFlush(user)

    return new UserRoleItem(user)
  }

  // Roles of the users the sender may see and change
  private manageableRoles(sender: User): readonly UserRole[] {
    switch (sender.role) {
      case UserRole.Admin:
        return Object.values(UserRole)
      case UserRole.OrgAdmin:
        return [...ORGANIZATION_ROLES, UserRole.User]
      default:
        throw new ForbiddenException(`Role '${sender.role}' cannot manage user roles`)
    }
  }

  private assignableRoles(sender: User): readonly UserRole[] {
    return sender.role === UserRole.Admin ? Object.values(UserRole) : ORGANIZATION_ROLES
  }
}
