import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseRepository } from './persistence/database.repository';
@Injectable()
export class ReadinessService {
  constructor(private readonly database: DatabaseRepository) {}
  async check(): Promise<{
    service: 'auth-service';
    status: 'ok';
    database: 'ok';
  }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.database.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Readiness timed out')),
            2000,
          );
        }),
      ]);
      return { service: 'auth-service', status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException({
        service: 'auth-service',
        status: 'unavailable',
        database: 'unavailable',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
