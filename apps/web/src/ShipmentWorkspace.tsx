import { Lifecycle, StatusBadge } from './ui';
import { DocumentAttachments } from './DocumentAttachments';
import { useEffect, useState } from 'react';
import {
  shipmentStatuses,
  canWriteOrganizationResource,
  type Shipment,
  type OrganizationRole,
} from '@pharma/contracts';
import { authenticatedRequest } from './auth';
export function ShipmentWorkspace({
  organizationId,
  shipmentId,
  role,
  navigate,
}: {
  organizationId: string;
  shipmentId?: string;
  role?: OrganizationRole;
  navigate: (path: string) => void;
}) {
  const base = `/organizations/${organizationId}/shipments`;
  const [rows, setRows] = useState<Shipment[]>([]),
    [detail, setDetail] = useState<Shipment | null>(null),
    [facilities, setFacilities] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [status, setStatus] = useState(''),
    [source, setSource] = useState(''),
    [destination, setDestination] = useState('');
  const write = !!role && canWriteOrganizationResource(role, 'shipment');
  useEffect(() => {
    let active = true;
    setDetail(null);
    void Promise.all([
      authenticatedRequest<{ items: Shipment[]; total: number }>(
        `${base}?page=${page}&pageSize=25${status ? '&status=' + status : ''}${source ? '&sourceFacilityId=' + source : ''}${destination ? '&destinationFacilityId=' + destination : ''}`,
      ),
      authenticatedRequest<{ id: string; name: string }[]>(
        `/organizations/${organizationId}/facilities`,
      ),
      shipmentId
        ? authenticatedRequest<Shipment>(`${base}/${shipmentId}`)
        : Promise.resolve(null),
    ])
      .then(([list, fac, row]) => {
        if (active) {
          setRows(list.items);
          setTotal(list.total);
          setFacilities(fac);
          setDetail(row);
        }
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : 'Unable to load shipments');
      });
    return () => {
      active = false;
    };
  }, [
    base,
    organizationId,
    shipmentId,
    page,
    status,
    source,
    destination,
    revision,
  ]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      const result = await authenticatedRequest<Shipment>(path, method, body);
      setRevision((v) => v + 1);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update shipment');
      setRevision((v) => v + 1);
      return null;
    } finally {
      setBusy(false);
    }
  }
  const facility = (id: string) =>
    facilities.find((f) => f.id === id)?.name ?? id;
  const options = facilities.map((f) => (
    <option key={f.id} value={f.id}>
      {f.name}
    </option>
  ));
  const commands: Record<string, string[]> = {
    CREATED: ['ready', 'cancel'],
    READY: ['dispatch', 'cancel'],
    DISPATCHED: ['in-transit', 'receive'],
    IN_TRANSIT: ['receive'],
  };
  return (
    <section>
      <h1>{detail?.shipmentNumber ?? 'Shipments'}</h1>
      <a
        href={base}
        onClick={(e) => {
          e.preventDefault();
          navigate(base);
        }}
      >
        All shipments
      </a>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!shipmentId && (
        <>
          <div className="domain-form">
            <label>
              Status
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                {shipmentStatuses.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Source
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All facilities</option>
                {options}
              </select>
            </label>
            <label>
              Destination
              <select
                value={destination}
                onChange={(e) => {
                  setDestination(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All facilities</option>
                {options}
              </select>
            </label>
          </div>
          {write && (
            <form
              className="domain-form"
              onSubmit={(e) => {
                e.preventDefault();
                const values = new FormData(e.currentTarget);
                void mutate(base, 'POST', {
                  shipmentNumber: values.get('number'),
                  sourceFacilityId: values.get('source'),
                  destinationFacilityId: values.get('destination'),
                }).then((row) => {
                  if (row) navigate(`${base}/${row.id}`);
                });
              }}
            >
              <h2>Create shipment</h2>
              <label>
                Shipment number
                <input name="number" required maxLength={100} />
              </label>
              <label>
                Source
                <select name="source" required>
                  <option value="">Select facility</option>
                  {options}
                </select>
              </label>
              <label>
                Destination
                <select name="destination" required>
                  <option value="">Select facility</option>
                  {options}
                </select>
              </label>
              <button disabled={busy}>Create shipment</button>
            </form>
          )}
          <table>
            <thead>
              <tr>
                <th>Shipment</th>
                <th>Source</th>
                <th>Destination</th>
                <th>Status</th>
                <th>Created</th>
                <th>Dispatched</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <a
                      href={`${base}/${row.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`${base}/${row.id}`);
                      }}
                    >
                      {row.shipmentNumber}
                    </a>
                  </td>
                  <td>{facility(row.sourceFacilityId)}</td>
                  <td>{facility(row.destinationFacilityId)}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{row.dispatchedAt ?? '—'}</td>
                  <td>{row.receivedAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button disabled={page === 1} onClick={() => setPage((v) => v - 1)}>
            Previous
          </button>{' '}
          Page {page} · {total} shipments{' '}
          <button
            disabled={page * 25 >= total}
            onClick={() => setPage((v) => v + 1)}
          >
            Next
          </button>
        </>
      )}
      {detail && (
        <>
          <Lifecycle
            states={[
              'CREATED',
              'READY',
              'DISPATCHED',
              'IN_TRANSIT',
              'RECEIVED',
              ...(detail.status === 'CANCELLED' ? ['CANCELLED'] : []),
            ]}
            current={detail.status}
          />
          <DocumentAttachments
            base={`${base}/${detail.id}`}
            domain="SHIPMENT"
            write={write}
            admin={role === 'ORG_ADMIN'}
          />
          <p>
            {facility(detail.sourceFacilityId)} →{' '}
            {facility(detail.destinationFacilityId)}
          </p>
          <p>
            Created: {detail.createdAt} · Dispatched:{' '}
            {detail.dispatchedAt ?? '—'} · Received: {detail.receivedAt ?? '—'}{' '}
            · Cancelled: {detail.cancelledAt ?? '—'}
          </p>
          {write &&
            (commands[detail.status] ?? []).map((command) => (
              <button
                key={command}
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `${command} shipment ${detail.shipmentNumber}?`,
                    )
                  )
                    void mutate(`${base}/${detail.id}/${command}`, 'POST', {});
                }}
              >
                {command}
              </button>
            ))}
          <h2>Contents</h2>
          <ul>
            {detail.contents?.map((c) => (
              <li key={c.id}>
                <a
                  href={`/organizations/${organizationId}/${c.kind === 'items' ? 'serials' : 'aggregates'}/${c.referenceId}`}
                >
                  {c.kind}: {c.referenceId}
                </a>{' '}
                ·{' '}
                <a
                  href={`/organizations/${organizationId}/trace/${c.kind === 'items' ? 'serials' : 'aggregates'}/${c.referenceId}`}
                >
                  Trace history
                </a>
                {write && detail.status === 'CREATED' && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('Remove shipment content?'))
                        void mutate(
                          `${base}/${detail.id}/${c.kind}/${c.referenceId}`,
                          'DELETE',
                        );
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {write && detail.status === 'CREATED' && (
            <form
              className="domain-form"
              onSubmit={(e) => {
                e.preventDefault();
                const values = new FormData(e.currentTarget);
                void mutate(
                  `${base}/${detail.id}/${String(values.get('kind'))}`,
                  'POST',
                  { referenceId: values.get('reference') },
                );
              }}
            >
              <h2>Add contents</h2>
              <label>
                Type
                <select name="kind">
                  <option value="items">Serialized item</option>
                  <option value="containers">Aggregate container</option>
                </select>
              </label>
              <label>
                Reference UUID
                <input name="reference" required pattern="[a-fA-F0-9-]{36}" />
              </label>
              <button disabled={busy}>Add content</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
