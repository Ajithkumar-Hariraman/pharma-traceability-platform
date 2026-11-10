/* global Response */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  ConfigService,
} = require('../services/aggregation-service/node_modules/@nestjs/config');
const {
  AggregationService,
} = require('../services/aggregation-service/dist/aggregation.service');
const {
  AggregationController,
} = require('../services/aggregation-service/dist/aggregation.controller');
const {
  AggregationProxy,
} = require('../apps/api-gateway/dist/aggregation/aggregation-proxy');

test('serial parent contract preserves absent parents and downstream failures', async (t) => {
  const org = randomUUID(),
    user = randomUUID(),
    id = randomUUID();
  const parent = {
    id: randomUUID(),
    organizationId: org,
    containerCode: 'CASE-1',
    packagingLevel: 'CASE',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let status = 'CREATED',
    relation = null,
    failure;
  const service = new AggregationService(
    {
      aggregationRelation: {
        findFirst: async (query) => {
          assert.deepEqual(query.where, {
            organizationId: org,
            childSerializedItemId: id,
          });
          return relation;
        },
      },
    },
    {
      validate: async (...args) => {
        assert.deepEqual(args, [org, id, user, 'OPERATOR']);
        if (failure)
          throw Object.assign(new Error('downstream'), { status: failure });
        return { id, organizationId: org, status };
      },
    },
  );
  const controller = new AggregationController(service);
  const proxy = new AggregationProxy(
    new ConfigService({
      AGGREGATION_SERVICE_URL: 'http://aggregation',
      INTERNAL_IDENTITY_SECRET: 's'.repeat(40),
      AUTH_SERVICE_TIMEOUT_MS: 1000,
    }),
    {
      forward: async () => ({
        organizationId: org,
        userId: user,
        role: 'OPERATOR',
      }),
    },
  );
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const path = `/organizations/${org}/serials/${id}/parent`;
  globalThis.fetch = async () => {
    try {
      return Response.json(
        await controller.parent(org, id, { userId: user, role: 'OPERATOR' }),
      );
    } catch (error) {
      return Response.json({}, { status: error.status });
    }
  };
  for (status of ['CREATED', 'COMMISSIONED']) {
    assert.deepEqual(await proxy.forward('GET', path, user), { parent: null });
  }
  relation = { parent };
  assert.deepEqual(await proxy.forward('GET', path, user), { parent });
  for (failure of [404, 503, 504, 502]) {
    await assert.rejects(
      proxy.forward('GET', path, user),
      (error) => error.status === failure,
    );
  }
  for (const body of [
    '',
    'null',
    '{}',
    '{"parent":{}}',
    JSON.stringify({ parent: { ...parent, organizationId: randomUUID() } }),
  ]) {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    await assert.rejects(
      proxy.forward('GET', path, user),
      (error) => error.status === 502,
    );
  }
  globalThis.fetch = async () => new Response(null, { status: 204 });
  await assert.rejects(
    proxy.forward('GET', path, user),
    (error) => error.status === 502,
  );
  globalThis.fetch = async () => {
    throw new Error('network failure');
  };
  await assert.rejects(
    proxy.forward('GET', path, user),
    (error) => error.status === 503,
  );
});
