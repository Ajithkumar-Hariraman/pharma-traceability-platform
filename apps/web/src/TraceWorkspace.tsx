import { useEffect, useState } from 'react';
import {
  traceEventTypes,
  type TracePage,
  type TraceEvent,
} from '@pharma/contracts';
import { authenticatedRequest } from './auth';
export function TraceWorkspace({
  organizationId,
  scope,
  referenceId,
}: {
  organizationId: string;
  scope?: string;
  referenceId?: string;
}) {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [target, setTarget] = useState(scope ?? 'events');
  const [id, setId] = useState(referenceId ?? '');
  const [data, setData] = useState<TracePage | null>(null);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setSelected(null);
    const query = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (type) query.set('eventType', type);
    if (from)
      query.set('from', new Date(`${from}T00:00:00.000Z`).toISOString());
    if (to) query.set('to', new Date(`${to}T23:59:59.999Z`).toISOString());
    const resource =
      target === 'events' ? 'events' : `${target}/${encodeURIComponent(id)}`;
    if (target !== 'events' && !id) {
      setData(null);
      setLoading(false);
      return;
    }
    void authenticatedRequest<TracePage>(
      `/organizations/${organizationId}/trace/${resource}?${query}`,
    )
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) {
          setError(e instanceof Error ? e.message : 'Unable to load history');
          setData(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [organizationId, target, id, page, type, from, to, revision]);
  async function detail(event: TraceEvent) {
    setError('');
    try {
      setSelected(
        await authenticatedRequest<TraceEvent>(
          `/organizations/${organizationId}/trace/events/${encodeURIComponent(event.eventId)}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load event');
    }
  }
  return (
    <section>
      <h1>Traceability</h1>
      <p>
        Immutable business-event history. Times and date filters use UTC;
        timelines show oldest first.
      </p>
      <div className="domain-form">
        <label>
          History
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setId('');
              setPage(1);
            }}
          >
            <option value="events">All events</option>
            <option value="serials">Serial timeline</option>
            <option value="batches">Batch timeline</option>
            <option value="aggregates">Aggregate/container timeline</option>
          </select>
        </label>
        {target !== 'events' && (
          <label>
            Reference UUID
            <input
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                setPage(1);
              }}
            />
          </label>
        )}
        <label>
          Event type
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All types</option>
            {traceEventTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          From (UTC)
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          To (UTC)
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {loading && <p role="status">Loading trace history…</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button onClick={() => setRevision((v) => v + 1)}>Retry</button>
        </p>
      )}
      {!loading && data && (
        <>
          <p>{data.total} events</p>
          {!data.items.length ? (
            <p>No trace events match these filters.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event time (UTC)</th>
                    <th>Type</th>
                    <th>Action</th>
                    <th>Business step</th>
                    <th>Disposition</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((event) => (
                    <tr key={event.id}>
                      <td>{event.eventTime}</td>
                      <td>{event.eventType}</td>
                      <td>{event.action}</td>
                      <td>{event.businessStep ?? '—'}</td>
                      <td>{event.disposition ?? '—'}</td>
                      <td>
                        <button onClick={() => void detail(event)}>
                          View event
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="actions">
            <button disabled={page === 1} onClick={() => setPage((v) => v - 1)}>
              Previous
            </button>
            <span>Page {page}</span>
            <button
              disabled={page * data.pageSize >= data.total}
              onClick={() => setPage((v) => v + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
      {selected && (
        <section className="welcome-panel">
          <h2>Event detail</h2>
          <button onClick={() => setSelected(null)}>Close</button>
          <dl>
            {Object.entries(selected)
              .filter(([key]) => key !== 'metadata')
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value ?? '—')}</dd>
                </div>
              ))}
          </dl>
          {selected.metadata && (
            <>
              <h3>Metadata</h3>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify(selected.metadata, null, 2)}
              </pre>
            </>
          )}
        </section>
      )}
    </section>
  );
}
