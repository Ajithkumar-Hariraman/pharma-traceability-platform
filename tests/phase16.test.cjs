const { URL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Documents, ObjectStorage } = require('../packages/object-storage/dist');
const { validateStorageEnvironment } = require('../packages/config/dist');
const org = randomUUID(),
  domainId = randomUUID(),
  user = randomUUID();
const checksum = createHash('sha256').update('%PDF-test').digest('base64');
const input = {
  originalFileName: 'certificate.pdf',
  category: 'REGULATORY_CERTIFICATE',
  contentType: 'application/pdf',
  size: 9,
  checksum,
};
function fixture(domain = 'PRODUCT') {
  const rows = [];
  let fail = false,
    present = true;
  const storage = {
    config: validateStorageEnvironment({}),
    upload: async () => {
      if (fail) throw new Error('dependency');
      return 'https://storage.invalid/signed';
    },
    download: async () => 'https://storage.invalid/download',
    head: async () =>
      present
        ? {
            ContentLength: 9,
            ContentType: 'application/pdf',
            ChecksumSHA256: checksum,
            Metadata: { 'document-id': rows[0].id },
          }
        : null,
    delete: async () => {
      if (fail) throw new Error('dependency');
    },
  };
  const match = (row, where) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const db = {
    create: async ({ data }) => {
      const row = {
        createdAt: new Date(),
        finalizedAt: null,
        deletedAt: null,
        ...data,
      };
      rows.push(row);
      return row;
    },
    findFirst: async ({ where }) =>
      rows.find((row) => match(row, where)) ?? null,
    findMany: async ({ where, take }) =>
      rows
        .filter((row) =>
          where.OR
            ? row.status === 'DELETING' ||
              (row.status === 'PENDING' && row.expiresAt < new Date())
            : match(row, where),
        )
        .slice(0, take),
    updateMany: async ({ where, data }) => {
      const matched = rows.filter((row) => match(row, where));
      matched.forEach((row) => Object.assign(row, data));
      return { count: matched.length };
    },
  };
  const documents = new Documents(db, storage, domain, async (o, id) => {
    if (o !== org || id !== domainId)
      throw Object.assign(new Error('Not found'), { status: 404 });
  });
  return {
    documents,
    rows,
    storage,
    db,
    fail: () => {
      fail = true;
    },
    missing: () => {
      present = false;
    },
  };
}
const upload = (f, body = input, role = 'OPERATOR') =>
  f.documents.upload(org, domainId, user, role, body);
test('Phase16 creates pending upload with required signed headers and no object key leak', async () => {
  const f = fixture();
  const result = await upload(f);
  assert.equal(result.document.status, 'PENDING');
  assert.equal(result.document.uploadedBy, user);
  assert.equal(result.headers['x-amz-checksum-sha256'], checksum);
  assert.equal(result.document.objectKey, undefined);
  assert.ok(result.url);
});
test('Phase16 SDK generates short-lived private signed PUT and GET URLs', async () => {
  const saved = [
    process.env.AWS_ACCESS_KEY_ID,
    process.env.AWS_SECRET_ACCESS_KEY,
  ];
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local-secret';
  try {
    const store = new ObjectStorage({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'true',
    });
    const url = new URL(
      await store.upload(
        'organizations/key',
        'application/pdf',
        9,
        checksum,
        randomUUID(),
      ),
    );
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.ok(
      url.searchParams.get('X-Amz-SignedHeaders').includes('if-none-match'),
    );
    const download = new URL(
      await store.download('organizations/key', 'certificate.pdf'),
    );
    assert.equal(download.searchParams.get('X-Amz-Expires'), '120');
    assert.ok(
      download.searchParams
        .get('response-content-disposition')
        .startsWith('attachment;'),
    );
    assert.equal(url.searchParams.has('x-amz-acl'), false);
  } finally {
    for (const [i, key] of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ].entries()) {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }
  }
});
for (const name of [
  '../secret.pdf',
  'folder/cert.pdf',
  'folder\\cert.pdf',
  'bad\r\n.pdf',
  '.hidden.pdf',
  'a..pdf',
  'bad?.pdf',
])
  test(`Phase16 rejects unsafe filename ${JSON.stringify(name)}`, async () => {
    const f = fixture();
    await assert.rejects(upload(f, { ...input, originalFileName: name }), {
      status: 400,
    });
    assert.equal(f.rows.length, 0);
  });
for (const [name, change] of [
  ['category', { category: 'ARBITRARY' }],
  ['MIME', { contentType: 'application/javascript' }],
  ['extension mismatch', { originalFileName: 'code.png' }],
  ['oversize', { size: 10485761 }],
  ['checksum', { checksum: 'invalid' }],
])
  test(`Phase16 rejects invalid ${name}`, async () => {
    const f = fixture();
    await assert.rejects(upload(f, { ...input, ...change }), { status: 400 });
    assert.equal(f.rows.length, 0);
  });
test('Phase16 rejects arbitrary domains', () =>
  assert.throws(() => fixture('ARBITRARY'), { status: 400 }));
test('Phase16 keys isolate organizations and use generated names', async () => {
  const f = fixture();
  await upload(f);
  assert.match(
    f.rows[0].objectKey,
    new RegExp(`^organizations/${org}/product/${domainId}/[a-f0-9-]+/content$`),
  );
  assert.ok(!f.rows[0].objectKey.includes(input.originalFileName));
  await assert.rejects(
    f.documents.upload(randomUUID(), domainId, user, 'ORG_ADMIN', input),
  );
});
test('Phase16 finalize verifies metadata and activates idempotently', async () => {
  const f = fixture();
  const result = await upload(f);
  await f.documents.finalize(org, domainId, result.document.id, 'OPERATOR');
  assert.equal(f.rows[0].status, 'ACTIVE');
  assert.ok(f.rows[0].finalizedAt);
  await f.documents.finalize(org, domainId, result.document.id, 'OPERATOR');
  assert.equal((await f.documents.list(org, domainId)).length, 1);
});
test('Phase16 pending does not appear in available documents or allow download', async () => {
  const f = fixture();
  const result = await upload(f);
  assert.deepEqual(await f.documents.list(org, domainId), []);
  await assert.rejects(
    f.documents.download(org, domainId, result.document.id),
    { status: 409 },
  );
});
test('Phase16 missing object cannot finalize', async () => {
  const f = fixture();
  const result = await upload(f);
  f.missing();
  await assert.rejects(
    f.documents.finalize(org, domainId, result.document.id, 'ORG_ADMIN'),
    { status: 400 },
  );
  assert.equal(f.rows[0].status, 'PENDING');
});
for (const property of [
  'ContentLength',
  'ContentType',
  'ChecksumSHA256',
  'Metadata',
])
  test(`Phase16 mismatched object ${property} cannot finalize`, async () => {
    const f = fixture();
    const result = await upload(f);
    const head = f.storage.head;
    f.storage.head = async () => ({ ...(await head()), [property]: null });
    await assert.rejects(
      f.documents.finalize(org, domainId, result.document.id, 'ORG_ADMIN'),
      { status: 400 },
    );
  });
test('Phase16 authorized download; other organizations and domain IDs denied', async () => {
  const f = fixture();
  const result = await upload(f);
  await f.documents.finalize(org, domainId, result.document.id, 'ORG_ADMIN');
  assert.ok(
    (await f.documents.download(org, domainId, result.document.id)).url,
  );
  await assert.rejects(
    f.documents.download(randomUUID(), domainId, result.document.id),
  );
  await assert.rejects(
    f.documents.download(org, randomUUID(), result.document.id),
  );
});
test('Phase16 viewers cannot upload finalize or delete; operators cannot delete', async () => {
  const f = fixture();
  await assert.rejects(upload(f, input, 'VIEWER'), { status: 403 });
  const result = await upload(f);
  await assert.rejects(
    f.documents.finalize(org, domainId, result.document.id, 'VIEWER'),
    { status: 403 },
  );
  for (const role of ['VIEWER', 'OPERATOR'])
    await assert.rejects(
      f.documents.delete(org, domainId, result.document.id, role),
      { status: 403 },
    );
});
test('Phase16 admin deletes and hides metadata', async () => {
  const f = fixture();
  const result = await upload(f);
  await f.documents.delete(org, domainId, result.document.id, 'ORG_ADMIN');
  assert.equal(f.rows[0].status, 'DELETING');
  await assert.rejects(
    f.documents.download(org, domainId, result.document.id),
    { status: 409 },
  );
});
test('Phase16 failed presign leaves pending metadata recoverable by cleanup', async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(upload(f));
  assert.equal(f.rows[0].status, 'PENDING');
});
test('Phase16 object deletion failure persists durable retry state', async () => {
  const f = fixture();
  const result = await upload(f);
  f.fail();
  await assert.rejects(
    f.documents.delete(org, domainId, result.document.id, 'ORG_ADMIN'),
  );
  assert.equal(f.rows[0].status, 'DELETING');
  await assert.rejects(
    f.documents.download(org, domainId, result.document.id),
    { status: 409 },
  );
});
test('Phase16 cleanup expires abandoned uploads and retries deletion in bounded batches', async () => {
  const f = fixture();
  await upload(f);
  f.rows[0].expiresAt = new Date(0);
  await assert.rejects(
    f.documents.finalize(org, domainId, f.rows[0].id, 'ORG_ADMIN'),
    { status: 409 },
  );
  assert.equal((await f.documents.cleanup()).processed, 1);
  assert.equal(f.rows[0].status, 'DELETED');
});
for (const [domain, category] of [
  ['PRODUCT', 'SPECIFICATION'],
  ['RECALL', 'INVESTIGATION_EVIDENCE'],
  ['SHIPMENT', 'SHIPPING_MANIFEST'],
])
  test(`Phase16 ${domain} attachment lifecycle`, async () => {
    const f = fixture(domain);
    const result = await upload(f, { ...input, category });
    await f.documents.finalize(org, domainId, result.document.id, 'OPERATOR');
    assert.equal((await f.documents.list(org, domainId))[0].domainType, domain);
  });
for (const input of [
  { S3_BUCKET: '../bucket' },
  { S3_ENDPOINT: 'https://user:password@host' },
  { S3_FORCE_PATH_STYLE: 'yes' },
  { S3_UPLOAD_EXPIRY_SECONDS: 901 },
  { S3_DOWNLOAD_EXPIRY_SECONDS: 0 },
  { DOCUMENT_MAX_FILE_SIZE: -1 },
  { DOCUMENT_ALLOWED_CONTENT_TYPES: 'text/html' },
  { AWS_REGION: 'bad' },
  { AWS_ACCESS_KEY_ID: 'incomplete' },
])
  test(`Phase16 config rejects ${Object.keys(input)[0]}`, () =>
    assert.throws(() => validateStorageEnvironment(input)));
test('Phase16 SDK sanitizes credential/presign errors', async () => {
  const store = new ObjectStorage();
  store.client = {
    config: {},
    send: async () => {
      throw new Error('secret');
    },
  };
  await assert.rejects(
    store.delete('key'),
    (error) => error.status === 503 && !error.message.includes('secret'),
  );
});

test('Phase16 deletion tombstone catches objects recreated during a valid upload window', async () => {
  const f = fixture();
  const result = await upload(f);
  let deletes = 0;
  f.storage.delete = async () => {
    deletes++;
  };
  await f.documents.delete(org, domainId, result.document.id, 'ORG_ADMIN');
  await f.documents.cleanup();
  assert.equal(deletes, 2);
  assert.equal(f.rows[0].status, 'DELETING');
  f.rows[0].expiresAt = new Date(0);
  await f.documents.cleanup();
  assert.equal(deletes, 3);
  assert.equal(f.rows[0].status, 'DELETED');
});
test('Phase16 cleanup processes at most 100 metadata rows per sweep', async () => {
  const f = fixture();
  await upload(f);
  const original = { ...f.rows[0], expiresAt: new Date(0) };
  f.rows.length = 0;
  for (let i = 0; i < 101; i++) f.rows.push({ ...original, id: randomUUID() });
  assert.equal((await f.documents.cleanup()).processed, 100);
  assert.equal(f.rows.filter((row) => row.status === 'PENDING').length, 1);
});
test('Phase16 cleanup does not delete an object when its claim loses a race', async () => {
  const f = fixture();
  await upload(f);
  f.rows[0].expiresAt = new Date(0);
  f.db.updateMany = async () => ({ count: 0 });
  f.storage.delete = async () => {
    assert.fail('Must not delete an unclaimed object');
  };
  await f.documents.cleanup();
  assert.equal(f.rows[0].status, 'PENDING');
});
test('Phase16 transient HEAD failure leaves finalization retryable', async () => {
  const f = fixture();
  const result = await upload(f);
  const head = f.storage.head;
  f.storage.head = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(
    f.documents.finalize(org, domainId, result.document.id, 'OPERATOR'),
  );
  assert.equal(f.rows[0].status, 'PENDING');
  f.storage.head = head;
  await f.documents.finalize(org, domainId, result.document.id, 'OPERATOR');
  assert.equal(f.rows[0].status, 'ACTIVE');
});
test('Phase16 pending TTL must outlast signed upload capability', () => {
  assert.throws(() =>
    validateStorageEnvironment({ DOCUMENT_PENDING_TTL_SECONDS: 300 }),
  );
});
