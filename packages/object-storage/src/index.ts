import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { validateStorageEnvironment } from '@pharma/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const documentCategories = {
  PRODUCT: ['REGULATORY_CERTIFICATE', 'AUTHORIZATION', 'SPECIFICATION'],
  RECALL: ['RECALL_NOTICE', 'INVESTIGATION_EVIDENCE', 'REGULATORY_DOCUMENT'],
  SHIPMENT: ['PACKING_DOCUMENT', 'SHIPPING_MANIFEST', 'RECEIVING_EVIDENCE'],
} as const;
export type Domain = keyof typeof documentCategories;
export class ObjectStorage {
  readonly config;
  private readonly client;
  constructor(input: Record<string, unknown> = process.env) {
    this.config = validateStorageEnvironment(input);
    this.client = new S3Client({
      region: this.config.AWS_REGION,
      endpoint: this.config.S3_ENDPOINT,
      forcePathStyle: this.config.S3_FORCE_PATH_STYLE,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
    });
  }
  private async dependency<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new ServiceUnavailableException('Object storage unavailable');
    }
  }
  upload(
    key: string,
    contentType: string,
    size: number,
    checksum: string,
    documentId: string,
  ) {
    return this.dependency(() =>
      getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: key,
          ContentType: contentType,
          ContentLength: size,
          ChecksumSHA256: checksum,
          Metadata: { 'document-id': documentId },
          IfNoneMatch: '*',
        }),
        {
          expiresIn: this.config.S3_UPLOAD_EXPIRY_SECONDS,
          signableHeaders: new Set([
            'content-type',
            'content-length',
            'if-none-match',
          ]),
          unhoistableHeaders: new Set([
            'x-amz-checksum-sha256',
            'x-amz-meta-document-id',
          ]),
        },
      ),
    );
  }
  download(key: string, filename: string) {
    return this.dependency(() =>
      getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: key,
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        }),
        { expiresIn: this.config.S3_DOWNLOAD_EXPIRY_SECONDS },
      ),
    );
  }
  async head(key: string) {
    try {
      return await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: key,
          ChecksumMode: 'ENABLED',
        }),
      );
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      )
        return null;
      throw new ServiceUnavailableException('Object storage unavailable');
    }
  }
  delete(key: string) {
    return this.dependency(() =>
      this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
      ),
    );
  }
}
export interface DocumentRow {
  id: string;
  organizationId: string;
  domainType: string;
  domainId: string;
  category: string;
  originalFileName: string;
  objectKey: string;
  contentType: string;
  size: number;
  checksum: string;
  status: string;
  uploadedBy: string;
  createdAt: Date;
  expiresAt: Date;
  finalizedAt: Date | null;
  deletedAt: Date | null;
}
export interface DocumentRepository {
  create(args: {
    data: Omit<DocumentRow, 'createdAt' | 'finalizedAt' | 'deletedAt'>;
  }): Promise<DocumentRow>;
  findFirst(args: { where: Partial<DocumentRow> }): Promise<DocumentRow | null>;
  findMany(args: {
    where: Partial<DocumentRow> & {
      OR?: Array<{ status: string; expiresAt?: { lt: Date } }>;
    };
    take: number;
    orderBy: { createdAt: 'asc' | 'desc' };
  }): Promise<DocumentRow[]>;
  updateMany(args: {
    where: Partial<DocumentRow>;
    data: Partial<DocumentRow>;
  }): Promise<{ count: number }>;
}
export class Documents {
  constructor(
    private readonly db: DocumentRepository,
    private readonly storage: ObjectStorage,
    private readonly domain: Domain,
    private readonly owner: (org: string, id: string) => Promise<unknown>,
  ) {
    if (!Object.hasOwn(documentCategories, domain))
      throw new BadRequestException('Invalid document domain');
  }
  private async scope(org: string, id: string) {
    if (
      !z.string().uuid().safeParse(org).success ||
      !z.string().uuid().safeParse(id).success
    )
      throw new BadRequestException('Invalid document scope');
    await this.owner(org, id);
  }
  private write(role: string, deleting = false) {
    if (
      deleting
        ? role !== 'ORG_ADMIN'
        : !['ORG_ADMIN', 'OPERATOR'].includes(role)
    )
      throw new ForbiddenException('Document permission required');
  }
  private public(row: DocumentRow) {
    const { objectKey: _key, checksum: _checksum, ...data } = row;
    void _key;
    void _checksum;
    return data;
  }
  async upload(
    org: string,
    id: string,
    user: string,
    role: string,
    body: unknown,
  ) {
    this.write(role);
    await this.scope(org, id);
    const parsed = z
      .object({
        originalFileName: z
          .string()
          .min(1)
          .max(180)
          .regex(/^[\p{L}\p{N} _().-]+$/u)
          .refine(
            (x) => !x.includes('..') && x.trim() === x && !x.startsWith('.'),
          ),
        category: z.string(),
        contentType: z.string(),
        size: z
          .number()
          .int()
          .positive()
          .max(this.storage.config.DOCUMENT_MAX_FILE_SIZE),
        checksum: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid document metadata');
    const data = parsed.data;
    const extensions: Record<string, string[]> = {
      'application/pdf': ['pdf'],
      'image/png': ['png'],
      'image/jpeg': ['jpg', 'jpeg'],
      'text/csv': ['csv'],
    };
    if (
      !(documentCategories[this.domain] as readonly string[]).includes(
        data.category,
      ) ||
      !this.storage.config.DOCUMENT_ALLOWED_CONTENT_TYPES.includes(
        data.contentType,
      ) ||
      !extensions[data.contentType]?.includes(
        data.originalFileName.split('.').pop()!.toLowerCase(),
      )
    )
      throw new BadRequestException('Unsupported document category or type');
    const documentId = randomUUID();
    const objectKey = `organizations/${org}/${this.domain.toLowerCase()}/${id}/${documentId}/content`;
    const row = await this.db.create({
      data: {
        ...data,
        id: documentId,
        organizationId: org,
        domainType: this.domain,
        domainId: id,
        objectKey,
        status: 'PENDING',
        uploadedBy: user,
        expiresAt: new Date(
          Date.now() + this.storage.config.DOCUMENT_PENDING_TTL_SECONDS * 1000,
        ),
      },
    });
    const url = await this.storage.upload(
      objectKey,
      data.contentType,
      data.size,
      data.checksum,
      documentId,
    );
    return {
      document: this.public(row),
      url,
      headers: {
        'Content-Type': data.contentType,
        'x-amz-checksum-sha256': data.checksum,
        'x-amz-meta-document-id': documentId,
        'If-None-Match': '*',
      },
    };
  }
  async list(org: string, id: string) {
    await this.scope(org, id);
    return (
      await this.db.findMany({
        where: {
          organizationId: org,
          domainId: id,
          domainType: this.domain,
          status: 'ACTIVE',
        },
        take: 200,
        orderBy: { createdAt: 'desc' },
      })
    ).map((row) => this.public(row));
  }
  private async row(org: string, id: string, documentId: string) {
    await this.scope(org, id);
    const row = await this.db.findFirst({
      where: {
        id: documentId,
        organizationId: org,
        domainId: id,
        domainType: this.domain,
      },
    });
    if (!row || row.status === 'DELETED')
      throw new NotFoundException('Document not found');
    return row;
  }
  async finalize(org: string, id: string, documentId: string, role: string) {
    this.write(role);
    const row = await this.row(org, id, documentId);
    if (row.status === 'ACTIVE') return this.public(row);
    if (row.status !== 'PENDING' || row.expiresAt.getTime() <= Date.now())
      throw new ConflictException('Upload expired or unavailable');
    const object = await this.storage.head(row.objectKey);
    if (
      !object ||
      object.ContentLength !== row.size ||
      object.ContentType !== row.contentType ||
      object.Metadata?.['document-id'] !== row.id ||
      object.ChecksumSHA256 !== row.checksum
    )
      throw new BadRequestException(
        'Uploaded object missing or metadata mismatch',
      );
    const finalizedAt = new Date();
    const result = await this.db.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'ACTIVE', finalizedAt },
    });
    if (!result.count) throw new ConflictException('Document changed; retry');
    return this.public({ ...row, status: 'ACTIVE', finalizedAt });
  }
  async download(org: string, id: string, documentId: string) {
    const row = await this.row(org, id, documentId);
    if (row.status !== 'ACTIVE')
      throw new ConflictException('Document unavailable');
    return {
      url: await this.storage.download(row.objectKey, row.originalFileName),
    };
  }
  async delete(org: string, id: string, documentId: string, role: string) {
    this.write(role, true);
    const row = await this.row(org, id, documentId);
    // Persist retry intent before deleting: download/finalize are blocked immediately.
    await this.db.updateMany({
      where: { id: row.id },
      data: { status: 'DELETING' },
    });
    await this.storage.delete(row.objectKey);
    await this.db.updateMany({
      where: { id: row.id, status: 'DELETING' },
      data: {
        status: row.expiresAt.getTime() <= Date.now() ? 'DELETED' : 'DELETING',
        deletedAt: new Date(),
      },
    });
    return { deleted: true };
  }
  async cleanup() {
    const rows = await this.db.findMany({
      where: {
        OR: [
          { status: 'PENDING', expiresAt: { lt: new Date() } },
          { status: 'DELETING' },
        ],
      },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) {
      const claimed = await this.db.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: 'DELETING' },
      });
      if (!claimed.count) continue;
      try {
        await this.storage.delete(row.objectKey);
        await this.db.updateMany({
          where: { id: row.id, status: 'DELETING' },
          data: {
            status:
              row.expiresAt.getTime() <= Date.now() ? 'DELETED' : 'DELETING',
            deletedAt: new Date(),
          },
        });
      } catch {
        /* Retry durable deletion intent next sweep. */
      }
    }
    return { processed: rows.length };
  }
}
