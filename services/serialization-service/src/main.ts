import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '@pharma/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const config = app.get(ConfigService<AppEnvironment, true>);
  try {
    await app.listen(
      config.get('PORT', { infer: true }),
      config.get('HOST', { infer: true }),
    );
  } catch {
    await app.close();
    throw new Error('Serialization Service startup failed');
  }
}
void bootstrap().catch(() => {
  process.stderr.write('Serialization Service startup failed\n');
  process.exitCode = 1;
});
