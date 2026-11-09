'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { TracePage } from '@pharma/contracts';
import { authenticatedRequest } from './auth';
import { PageHeader, Timeline } from './ui';
const summaries = [
  { title: 'Products', path: 'products', paged: false },
  { title: 'Batches', path: 'batches', paged: false },
  { title: 'Aggregates', path: 'aggregates', paged: false },
  { title: 'Shipments', path: 'shipments?page=1&pageSize=1', paged: true },
  {
    title: 'Active recalls',
    path: 'recalls?status=ACTIVE&page=1&pageSize=1',
    paged: true,
  },
];
export function OrganizationDashboard({
  organizationId,
  name,
}: {
  organizationId: string;
  name: string;
}) {
  const [counts, setCounts] = useState<(number | null)[]>([]);
  const [history, setHistory] = useState<TracePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const base = `/organizations/${organizationId}`;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setCounts([]);
    setHistory(null);
    void Promise.allSettled([
      ...summaries.map(async (summary) => {
        const data = await authenticatedRequest<unknown>(
          `${base}/${summary.path}`,
        );
        return summary.paged
          ? (data as { total: number }).total
          : (data as unknown[]).length;
      }),
      (async () => {
        const first = await authenticatedRequest<TracePage>(
          `${base}/trace/events?page=1&pageSize=5`,
        );
        const lastPage = Math.ceil(first.total / 5);
        if (lastPage <= 1)
          return { ...first, items: [...first.items].reverse() };
        const last = await authenticatedRequest<TracePage>(
          `${base}/trace/events?page=${lastPage}&pageSize=5`,
        );
        if (last.items.length < 5) {
          const previous = await authenticatedRequest<TracePage>(
            `${base}/trace/events?page=${lastPage - 1}&pageSize=5`,
          );
          return {
            ...last,
            items: [...previous.items, ...last.items].slice(-5).reverse(),
          };
        }
        return { ...last, items: [...last.items].reverse() };
      })(),
    ]).then((results) => {
      if (!active) return;
      setCounts(
        results
          .slice(0, summaries.length)
          .map((result) =>
            result.status === 'fulfilled' ? (result.value as number) : null,
          ),
      );
      const activity = results[summaries.length];
      if (activity?.status === 'fulfilled')
        setHistory(activity.value as TracePage);
      if (results.some((result) => result.status === 'rejected'))
        setError(
          'Some summaries could not be loaded. Your access or a service may be unavailable.',
        );
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [base, revision]);
  return (
    <section>
      <PageHeader
        title={name}
        description="Operational overview · organization-scoped records"
      />
      {error && (
        <p role="alert" className="alert error">
          {error}{' '}
          <button onClick={() => setRevision((v) => v + 1)}>Retry</button>
        </p>
      )}
      <div className="summary-grid" aria-busy={loading}>
        {summaries.map((summary, index) => (
          <Link
            className="summary-card"
            key={summary.title}
            href={`${base}/${summary.path.split('?')[0]}`}
          >
            <span>{summary.title}</span>
            <strong>{loading ? '…' : (counts[index] ?? 'Unavailable')}</strong>
            <small>
              {summary.paged
                ? 'Matching total'
                : 'Records returned by list API'}
            </small>
          </Link>
        ))}
      </div>
      <p className="input-help">
        Serialization is managed per batch.{' '}
        <Link href={`${base}/serials`}>
          Choose a batch to view serialized units →
        </Link>
      </p>
      <section className="welcome-panel">
        <div className="section-heading">
          <h2>Traceability activity</h2>
          <Link href={`${base}/trace`}>All events and filters →</Link>
        </div>
        <p className="muted">
          Latest five recorded business events, newest first. Event references
          identify the affected domain records.
        </p>
        {loading ? (
          <p role="status">Loading activity…</p>
        ) : history?.items.length ? (
          <Timeline events={history.items} organizationId={organizationId} />
        ) : (
          <p>
            {history
              ? 'No traceability events recorded.'
              : 'Activity is unavailable.'}
          </p>
        )}
      </section>
    </section>
  );
}
