import Link from 'next/link';
import type { TraceEvent } from '@pharma/contracts';
export const humanize = (value: string) =>
  value.replaceAll('_', ' ').toLowerCase();
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="status-pill" data-status={status}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}
export function LoadingState({ message = 'Loading…' }: { message?: string }) {
  return (
    <div className="loading" role="status">
      <span className="mark">P</span>
      <p>{message}</p>
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <section className="alert error" role="alert">
      <h2>Unable to load this view</h2>
      <p>{message}</p>
      {retry && (
        <button className="secondary" onClick={retry}>
          Retry
        </button>
      )}
    </section>
  );
}
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="welcome-panel">
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </section>
  );
}
export function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">PHARMA OPERATIONS</p>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
    </div>
  );
}
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <nav className="actions" aria-label="Pagination">
      <button
        className="secondary"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </button>
      <span aria-live="polite">
        Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
      </span>
      <button
        className="secondary"
        disabled={page * pageSize >= total}
        onClick={() => onChange(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
// Lifecycle states are alternatives for serials; a highlighted state does not imply earlier states occurred.
export function Lifecycle({
  states,
  current,
}: {
  states: readonly string[];
  current: string;
}) {
  return (
    <ol className="lifecycle" aria-label="Lifecycle states">
      {states.map((state) => (
        <li key={state} aria-current={state === current ? 'step' : undefined}>
          <StatusBadge status={state} />
          {state === current && <small>Current state</small>}
        </li>
      ))}
    </ol>
  );
}
const references = [
  ['productId', 'products', 'Product'],
  ['batchId', 'batches', 'Batch'],
  ['serializedItemId', 'serials', 'Serial'],
  ['aggregateContainerId', 'aggregates', 'Container'],
  ['childContainerId', 'aggregates', 'Child container'],
] as const;
export function EventReferences({
  event,
  organizationId,
}: {
  event: TraceEvent;
  organizationId: string;
}) {
  return (
    <div className="event-references">
      {references.map(
        ([key, route, label]) =>
          event[key] && (
            <Link
              key={key}
              href={`/organizations/${organizationId}/${route}/${event[key]}`}
            >
              {label}: {event[key]}
            </Link>
          ),
      )}
    </div>
  );
}
export function Timeline({
  events,
  organizationId,
  onDetail,
}: {
  events: TraceEvent[];
  organizationId: string;
  onDetail?: (event: TraceEvent) => void;
}) {
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <time dateTime={event.eventTime}>
            {new Date(event.eventTime).toLocaleString('en-GB', {
              timeZone: 'UTC',
            })}{' '}
            UTC
          </time>
          <h3>{humanize(event.businessStep ?? event.eventType)}</h3>
          <p>
            <StatusBadge status={event.eventType} /> · {event.action} ·{' '}
            {humanize(event.disposition ?? 'No disposition recorded')}
          </p>
          <EventReferences event={event} organizationId={organizationId} />
          {onDetail && (
            <button className="text-button" onClick={() => onDetail(event)}>
              View event details
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
