import { Injectable } from '@nestjs/common';
import {
  UserRepository,
  type StoredUserInput,
  type UserRecord,
} from './user.repository';

@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {}
  // Internal persistence operation; HTTP registration hashes through PasswordService.
  create(input: StoredUserInput): Promise<UserRecord> {
    const email = this.normalizeEmail(input.email);
    const bcrypt = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
    const argon2 =
      /^\$argon2(?:id|i|d)\$v=\d+\$m=\d+,(?:t=\d+,p=\d+|p=\d+,t=\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
    if (!bcrypt.test(input.passwordHash) && !argon2.test(input.passwordHash))
      throw new Error('An encoded password hash is required');
    return this.users.create({ ...input, email });
  }
  findByEmail(email: string): Promise<UserRecord | null> {
    return this.users.findByEmail(this.normalizeEmail(email));
  }
  private normalizeEmail(value: string): string {
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('A valid email is required');
    return email;
  }
}
