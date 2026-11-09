const { Buffer } = require('node:buffer');
const console = require('node:console');
// Real PostgreSQL, signed internal HTTP identity, presigned PUT/GET, and private MinIO.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { URL } = require('node:url');
const { ObjectStorage } = require('../packages/object-storage/dist');
const {
  DocumentProxy,
} = require('../apps/api-gateway/dist/documents/document-proxy');
const {
  ConfigService,
} = require('../services/product-service/node_modules/@nestjs/config');
const {
  Module,
  NotFoundException,
} = require('../services/product-service/node_modules/@nestjs/common');
const {
  NestFactory,
} = require('../services/product-service/node_modules/@nestjs/core');
async function main() {
  const storageEnv = parseEnv(
    readFileSync('services/product-service/.env', 'utf8'),
  );
  process.env.AWS_ACCESS_KEY_ID = storageEnv.AWS_ACCESS_KEY_ID;
  process.env.AWS_SECRET_ACCESS_KEY = storageEnv.AWS_SECRET_ACCESS_KEY;
  const storage = new ObjectStorage(storageEnv);
  const org = randomUUID(),
    user = randomUUID(),
    other = randomUUID();
  const bytes = Buffer.from('%PDF-1.4\nPhase16 smoke evidence\n');
  const checksum = createHash('sha256').update(bytes).digest('base64');
  for (const [domain, category] of [
    ['product', 'SPECIFICATION'],
    ['recall', 'INVESTIGATION_EVIDENCE'],
    ['shipment', 'SHIPPING_MANIFEST'],
  ]) {
    const env = parseEnv(
      readFileSync(`services/${domain}-service/.env`, 'utf8'),
    );
    const { PrismaClient } = require(
      `../services/${domain}-service/generated/client`,
    );
    const { PrismaService } = require(
      `../services/${domain}-service/dist/persistence/prisma.service`,
    );
    const { DocumentController } = require(
      `../services/${domain}-service/dist/document.controller`,
    );
    const { InternalIdentityGuard } = require(
      `../services/${domain}-service/dist/authorization`,
    );
    const Owner = require(
      `../services/${domain}-service/dist/${domain}.service`,
    )[`${domain[0].toUpperCase() + domain.slice(1)}Service`];
    const db = new PrismaClient({
      datasources: { db: { url: env.DATABASE_URL } },
    });
    const id = randomUUID();
    const data =
      domain === 'product'
        ? { id, organizationId: org, name: 'Phase16 smoke' }
        : domain === 'shipment'
          ? {
              id,
              organizationId: org,
              shipmentNumber: `smoke-${id}`,
              sourceFacilityId: randomUUID(),
              destinationFacilityId: randomUUID(),
            }
          : {
              id,
              organizationId: org,
              recallNumber: `smoke-${id}`,
              title: 'Phase16 smoke',
              reason: 'Integration test',
              severity: 'HIGH',
              scopeKey: `product:${id}`,
              productId: id,
              createdBy: user,
            };
    let app;
    try {
      await db[domain].create({ data });
      class SmokeModule {}
      Module({
        controllers: [DocumentController],
        providers: [
          InternalIdentityGuard,
          { provide: PrismaService, useValue: db },
          {
            provide: ConfigService,
            useValue: new ConfigService({ ...env, storage: storageEnv }),
          },
          {
            provide: Owner,
            useValue: {
              get: async (organizationId, domainId) => {
                const row = await db[domain].findFirst({
                  where: { id: domainId, organizationId },
                });
                if (!row) throw new NotFoundException();
                return row;
              },
            },
          },
        ],
      })(SmokeModule);
      app = await NestFactory.create(SmokeModule, {
        logger: false,
        rawBody: true,
      });
      await app.listen(0, '127.0.0.1');
      let role = 'OPERATOR';
      const proxy = new DocumentProxy(
        new ConfigService({
          [`${domain.toUpperCase()}_SERVICE_URL`]: await app.getUrl(),
          INTERNAL_IDENTITY_SECRET: env.INTERNAL_IDENTITY_SECRET,
          AUTH_SERVICE_TIMEOUT_MS: 5000,
        }),
        {
          forward: async (method, path, actor) => ({
            organizationId: path.split('/')[2],
            userId: actor,
            role,
          }),
        },
      );
      const path = `/organizations/${org}/${domain}s/${id}/documents`;
      const upload = await proxy.forward('POST', `${path}/uploads`, user, {
        originalFileName: 'smoke.pdf',
        category,
        contentType: 'application/pdf',
        size: bytes.length,
        checksum,
      });
      assert.equal(upload.document.status, 'PENDING');
      const preflight = await fetch(upload.url, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': Object.keys(upload.headers).join(
            ',',
          ),
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get('access-control-allow-origin'),
        'http://localhost:5173',
      );
      assert.equal((await fetch(`${await app.getUrl()}${path}`)).status, 401);
      const response = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: bytes,
      });
      assert.equal(
        response.status,
        200,
        `PUT failed: ${await response.text()}`,
      );
      assert.equal(
        (
          await fetch(upload.url, {
            method: 'PUT',
            headers: upload.headers,
            body: bytes,
          })
        ).status,
        412,
        'Conditional PUT must prevent overwrites',
      );
      const unsigned = new URL(upload.url);
      unsigned.search = '';
      assert.equal((await fetch(unsigned)).status, 403);
      const finalized = await proxy.forward(
        'POST',
        `${path}/${upload.document.id}/finalize`,
        user,
        {},
      );
      assert.equal(finalized.status, 'ACTIVE');
      const list = await proxy.forward('GET', path, user);
      assert.equal(list.length, 1);
      role = 'VIEWER';
      const download = await proxy.forward(
        'GET',
        `${path}/${upload.document.id}/download`,
        user,
      );
      assert.deepEqual(
        Buffer.from(await (await fetch(download.url)).arrayBuffer()),
        bytes,
      );
      await assert.rejects(proxy.forward('POST', `${path}/uploads`, user, {}), {
        status: 403,
      });
      await assert.rejects(
        proxy.forward('DELETE', `${path}/${upload.document.id}`, user),
        { status: 403 },
      );
      await assert.rejects(
        proxy.forward(
          'GET',
          path.replace(org, other) + `/${upload.document.id}/download`,
          user,
        ),
        { status: 404 },
      );
      role = 'ORG_ADMIN';
      await proxy.forward('DELETE', `${path}/${upload.document.id}`, user);
      assert.equal(
        await storage.head(
          (await db.document.findFirst({ where: { id: upload.document.id } }))
            .objectKey,
        ),
        null,
      );
      assert.deepEqual(await proxy.forward('GET', path, user), []);
      console.log(
        `${domain}: upload / conditional write / finalize / list / private download / tenant isolation / Viewer restrictions / delete passed`,
      );
    } finally {
      if (app) await app.close();
      const rows = await db.document.findMany({
        where: { organizationId: org },
      });
      for (const row of rows) await storage.delete(row.objectKey);
      await db.document.deleteMany({ where: { organizationId: org } });
      await db[domain].deleteMany({ where: { id } });
      await db.$disconnect();
    }
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
