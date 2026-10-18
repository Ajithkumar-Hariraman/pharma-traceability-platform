import { Injectable } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../persistence/prisma.service';

export interface StoredUserInput {
  email: string;
  passwordHash: string;
  status?: UserStatus;
}
// Hashes stay inside persistence; callers receive only the public user fields.
const userSelect = {
  id: true,
  email: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;
export type UserRecord = Prisma.UserGetPayload<{ select: typeof userSelect }>;

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}
  create(input: StoredUserInput): Promise<UserRecord> {
    return this.prisma.user.create({ data: input, select: userSelect });
  }
  findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: userSelect,
    });
  }
}
