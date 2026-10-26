export interface HealthResponse {
  service:
    | 'api-gateway'
    | 'auth-service'
    | 'organization-service'
    | 'product-service'
    | 'batch-service'
    | 'serialization-service'
    | 'aggregation-service'
    | 'traceability-service';
  status: 'ok';
}

export interface AuthUser {
  id: string;
  email: string;
  status: 'ACTIVE';
}
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}
export interface BrowserSession {
  accessToken: string;
}

export type OrganizationRole = 'ORG_ADMIN' | 'OPERATOR' | 'VIEWER';
export type FacilityType =
  'MANUFACTURER' | 'DISTRIBUTOR' | 'WHOLESALER' | 'DISPENSER';
export interface Organization {
  id: string;
  legalName: string;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
}
export interface Facility {
  id: string;
  organizationId: string;
  name: string;
  type: FacilityType;
  gln: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
}
export interface Membership {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
}
export function identityPayload(
  method: string,
  path: string,
  timestamp: string,
  userId: string,
  body: string,
): string {
  return [method, path, timestamp, userId, body].join('\n');
}

export type ProductStatus = 'ACTIVE' | 'INACTIVE';
export const packagingLevels = ['EACH', 'INNER', 'CASE', 'PALLET'] as const;
export type PackagingLevel = (typeof packagingLevels)[number];
export interface Product {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  manufacturerName: string | null;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
}
export interface GTIN {
  id: string;
  productId: string;
  organizationId: string;
  gtin: string;
  packagingLevel: PackagingLevel;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
}
export function productIdentityPayload(
  method: string,
  path: string,
  timestamp: string,
  userId: string,
  body: string,
  organizationId: string,
  role: OrganizationRole,
): string {
  return (
    identityPayload(method, path, timestamp, userId, body) +
    '\n' +
    organizationId +
    '\n' +
    role
  );
}
export function normalizeGtin(input: string): string | null {
  const value = input.trim();
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return null;
  let sum = 0;
  for (
    let i = value.length - 2, weight = 3;
    i >= 0;
    i--, weight = weight === 3 ? 1 : 3
  )
    sum += Number(value[i]) * weight;
  if ((10 - (sum % 10)) % 10 !== Number(value[value.length - 1])) return null;
  return value.padStart(14, '0');
}

export const batchStatuses = [
  'ACTIVE',
  'QUARANTINED',
  'EXPIRED',
  'RECALLED',
  'CLOSED',
] as const;
export type BatchStatus = (typeof batchStatuses)[number];
export interface Batch {
  id: string;
  organizationId: string;
  productId: string;
  gtinId: string;
  lotNumber: string;
  manufactureDate: string | null;
  expiryDate: string | null;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
}
export interface ProductReference {
  organizationId: string;
  productId: string;
  gtinId: string;
}
export function canWriteOrganizationResource(
  role: OrganizationRole,
  resource: 'product' | 'batch' | 'serialization' | 'aggregation',
): boolean {
  return (
    role === 'ORG_ADMIN' || (resource !== 'product' && role === 'OPERATOR')
  );
}
export function validBatchDates(
  manufactureDate: string | null | undefined,
  expiryDate: string | null | undefined,
): boolean {
  return !manufactureDate || !expiryDate || expiryDate > manufactureDate;
}

export const serializedItemStatuses = [
  'CREATED',
  'COMMISSIONED',
  'DECOMMISSIONED',
  'QUARANTINED',
] as const;
export type SerializedItemStatus = (typeof serializedItemStatuses)[number];
export type SerialCommand = 'commission' | 'decommission' | 'quarantine';
export const MAX_SERIAL_LENGTH = 100;
export const MAX_BULK_SERIALS = 100;
export interface SerializedItem {
  id: string;
  organizationId: string;
  productId: string;
  gtinId: string;
  batchId: string;
  serialNumber: string;
  status: SerializedItemStatus;
  commissionedAt: string | null;
  decommissionedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface BatchReference {
  organizationId: string;
  productId: string;
  gtinId: string;
  batchId: string;
  status: BatchStatus;
}
export function canExecuteSerialCommand(
  role: OrganizationRole,
  command: SerialCommand,
): boolean {
  return (
    canWriteOrganizationResource(role, 'serialization') &&
    (command !== 'decommission' || role === 'ORG_ADMIN')
  );
}
export function canTransitionSerial(
  status: SerializedItemStatus,
  command: SerialCommand,
): boolean {
  return command === 'commission'
    ? status === 'CREATED'
    : command === 'decommission'
      ? status === 'COMMISSIONED'
      : status === 'CREATED' || status === 'COMMISSIONED';
}
export function normalizeSerialNumber(value: string): string | null {
  const serial = value.trim();
  return serial.length > 0 &&
    serial.length <= MAX_SERIAL_LENGTH &&
    [...serial].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
    ? serial
    : null;
}

export const traceEventTypes = [
  'OBJECT',
  'AGGREGATION',
  'TRANSACTION',
] as const;
export const traceActions = ['ADD', 'OBSERVE', 'DELETE'] as const;
export interface TraceCapture {
  organizationId: string;
  eventId: string;
  eventType: (typeof traceEventTypes)[number];
  action: (typeof traceActions)[number];
  eventTime: string;
  businessStep?: string | null;
  disposition?: string | null;
  facilityId?: string | null;
  productId?: string | null;
  gtinId?: string | null;
  batchId?: string | null;
  serializedItemId?: string | null;
  aggregateContainerId?: string | null;
  childContainerId?: string | null;
  parentEventId?: string | null;
  metadata?: Record<string, unknown> | null;
}
export interface TraceEvent extends TraceCapture {
  id: string;
  recordTime: string;
  createdAt: string;
}
export interface TracePage {
  items: TraceEvent[];
  page: number;
  pageSize: number;
  total: number;
}
export function traceCapturePayload(
  method: string,
  path: string,
  timestamp: string,
  caller: string,
  organizationId: string,
  raw: string,
): string {
  return JSON.stringify([method, path, timestamp, caller, organizationId, raw]);
}
export const aggregatePackagingLevels = ['INNER', 'CASE', 'PALLET'] as const;
export type AggregatePackagingLevel = (typeof aggregatePackagingLevels)[number];
export function canAggregate(
  child: 'EACH' | PackagingLevel,
  parent: PackagingLevel,
): boolean {
  return child === 'EACH'
    ? parent === 'INNER' || parent === 'CASE'
    : child === 'INNER'
      ? parent === 'CASE' || parent === 'PALLET'
      : child === 'CASE' && parent === 'PALLET';
}
export interface AggregateContainer {
  id: string;
  organizationId: string;
  containerCode: string;
  packagingLevel: AggregatePackagingLevel;
  status: 'ACTIVE' | 'CLOSED' | 'DECOMMISSIONED';
  createdAt: string;
  updatedAt: string;
}
export interface AggregateHierarchy extends AggregateContainer {
  children: AggregateHierarchy[];
  items: SerializedItem[];
}
