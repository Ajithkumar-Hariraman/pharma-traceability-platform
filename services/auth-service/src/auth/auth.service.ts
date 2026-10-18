import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthUser, AuthTokens } from '@pharma/contracts';
import { PrismaService } from '../persistence/prisma.service';
import { PasswordService } from './password.service';
const credentials = z
  .object({
    email: z.string().trim().toLowerCase().max(254).email(),
    password: z.string().min(12).max(128),
  })
  .strict();
const safeSelect = { id: true, email: true, status: true } as const;
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}
  private parse(body: unknown) {
    const result = credentials.safeParse(body);
    if (!result.success)
      throw new BadRequestException(
        'Enter a valid email and a password of 12–128 characters',
      );
    return result.data;
  }
  async register(body: unknown): Promise<AuthUser> {
    const data = this.parse(body);
    const passwordHash = await this.passwords.hash(data.password);
    try {
      const user = await this.prisma.user.create({
        data: { email: data.email, passwordHash },
        select: safeSelect,
      });
      return { id: user.id, email: user.email, status: 'ACTIVE' };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'An account with this email already exists',
        );
      throw error;
    }
  }
  async login(body: unknown) {
    const result = credentials.safeParse(body);
    if (!result.success)
      throw new UnauthorizedException('Invalid email or password');
    const user = await this.prisma.user.findUnique({
      where: { email: result.data.email },
    });
    // Spend equivalent hash work for unknown accounts to reduce account timing disclosure.
    const valid = user
      ? await this.passwords.verify(user.passwordHash, result.data.password)
      : (await this.passwords.hash(result.data.password), false);
    if (!user || !valid || user.status !== 'ACTIVE')
      throw new UnauthorizedException('Invalid email or password');
    return this.issue(user.id);
  }
  private async issue(
    userId: string,
    database: Prisma.TransactionClient = this.prisma,
  ): Promise<AuthTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    await database.refreshSession.create({
      data: {
        userId,
        tokenHash: digest(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    return {
      accessToken: await this.jwt.signAsync(
        { sub: userId },
        {
          secret: this.config.getOrThrow<string>('JWT_SECRET'),
          algorithm: 'HS256',
          expiresIn: '15m',
          issuer: 'pharma-auth',
          audience: 'pharma-gateway',
        },
      ),
      refreshToken,
    };
  }
  private token(body: unknown): string {
    const result = z
      .object({ refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .safeParse(body);
    if (!result.success) throw new UnauthorizedException('Invalid session');
    return result.data.refreshToken;
  }
  async refresh(body: unknown) {
    const tokenHash = digest(this.token(body));
    // Conditional update atomically claims a token; concurrent/replayed refreshes cannot both succeed.
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.refreshSession.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!session || session.user.status !== 'ACTIVE')
        throw new UnauthorizedException('Invalid session');
      const claimed = await tx.refreshSession.updateMany({
        where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      if (claimed.count !== 1)
        throw new UnauthorizedException('Invalid session');
      return this.issue(session.userId, tx);
    });
  }
  async logout(body: unknown) {
    await this.prisma.refreshSession.updateMany({
      where: { tokenHash: digest(this.token(body)), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }
  async currentUser(id: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: safeSelect,
    });
    if (!user || user.status !== 'ACTIVE')
      throw new UnauthorizedException('Invalid session');
    return { id: user.id, email: user.email, status: 'ACTIVE' };
  }
  async authenticate(authorization?: string) {
    try {
      if (!authorization?.startsWith('Bearer ')) throw new Error();
      const payload = await this.jwt.verifyAsync<{ sub: string }>(
        authorization.slice(7),
        {
          secret: this.config.getOrThrow<string>('JWT_SECRET'),
          algorithms: ['HS256'],
          issuer: 'pharma-auth',
          audience: 'pharma-gateway',
        },
      );
      if (!z.string().uuid().safeParse(payload.sub).success) throw new Error();
      return await this.currentUser(payload.sub);
    } catch {
      throw new UnauthorizedException('Invalid session');
    }
  }
}
