import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  canWriteOrganizationResource,
  canExecuteSerialCommand,
  canTransitionSerial,
  type AggregateContainer,
  type SerializedItem,
  type Batch,
  type Product,
  type GTIN,
  type OrganizationRole,
  type SerialCommand,
} from '@pharma/contracts';
import { authenticatedRequest } from './auth';
import {
  serialSchema,
  bulkSerialSchema,
  serialLines,
  type SerialForm,
  type BulkSerialForm,
} from './serial-forms';
const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const timestamp = (value: string | null) =>
  value ? new Date(value).toLocaleString() : 'Not yet recorded';
export function SerialWorkspace({
  organizationId,
  batchId,
  serialId,
  role,
  navigate,
}: {
  organizationId: string;
  batchId?: string;
  serialId?: string;
  role?: OrganizationRole;
  navigate: (path: string) => void;
}) {
  const base = `/organizations/${organizationId}`;
  const [parent, setParent] = useState<AggregateContainer | null>(null);
  const [serial, setSerial] = useState<SerializedItem | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [gtin, setGtin] = useState<GTIN | null>(null);
  const [rows, setRows] = useState<SerializedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<'single' | 'bulk' | null>(null);
  const [revision, setRevision] = useState(0);
  const single = useForm<SerialForm>({
    resolver: zodResolver(serialSchema),
    defaultValues: { serialNumber: '' },
  });
  const bulk = useForm<BulkSerialForm>({
    resolver: zodResolver(bulkSerialSchema),
    defaultValues: { lines: '' },
  });
  const write = !!role && canWriteOrganizationResource(role, 'serialization');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setEditor(null);
    setSerial(null);
    setBatch(null);
    setProduct(null);
    setGtin(null);
    void (async () => {
      try {
        const item = serialId
          ? await authenticatedRequest<SerializedItem>(
              `${base}/serials/${serialId}`,
            )
          : null;
        if (item) {
          const parentContainer =
            await authenticatedRequest<AggregateContainer | null>(
              `${base}/serials/${item.id}/parent`,
            );
          if (active) setParent(parentContainer);
        }
        const ownerBatch = item?.batchId ?? batchId;
        if (!ownerBatch) throw new Error('Select a batch to manage serials');
        const lot = await authenticatedRequest<Batch>(
          `${base}/batches/${ownerBatch}`,
        );
        const [p, g, items] = await Promise.all([
          authenticatedRequest<Product>(`${base}/products/${lot.productId}`),
          authenticatedRequest<GTIN>(
            `${base}/products/${lot.productId}/gtins/${lot.gtinId}`,
          ),
          item
            ? Promise.resolve([])
            : authenticatedRequest<SerializedItem[]>(
                `${base}/batches/${ownerBatch}/serials`,
              ),
        ]);
        if (active) {
          setSerial(item);
          setBatch(lot);
          setProduct(p);
          setGtin(g);
          setRows(items);
        }
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load serialized items',
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [base, batchId, serialId, revision]);
  const create = single.handleSubmit(async (values) => {
    setError('');
    try {
      const item = await authenticatedRequest<SerializedItem>(
        `${base}/batches/${batch?.id}/serials`,
        'POST',
        values,
      );
      single.reset();
      setEditor(null);
      setNotice('Serial created.');
      navigate(`${base}/serials/${item.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to create serial',
      );
    }
  });
  const createBulk = bulk.handleSubmit(async (values) => {
    setError('');
    try {
      const items = await authenticatedRequest<SerializedItem[]>(
        `${base}/batches/${batch?.id}/serials/bulk`,
        'POST',
        { serialNumbers: serialLines(values.lines) },
      );
      bulk.reset();
      setEditor(null);
      setNotice(`${items.length} serials created.`);
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to create serials',
      );
    }
  });
  async function command(action: SerialCommand) {
    if (!serial) return;
    setBusy(true);
    setError('');
    try {
      const updated = await authenticatedRequest<SerializedItem>(
        `${base}/serials/${serial.id}/${action}`,
        'POST',
        {},
      );
      setSerial(updated);
      setNotice(`Serial ${label(updated.status)}.`);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to change serial status',
      );
    } finally {
      setBusy(false);
    }
  }
  function link(href: string, text: string) {
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          navigate(href);
        }}
      >
        {text}
      </a>
    );
  }
  if (loading) return <p role="status">Loading serialized items…</p>;
  return (
    <section>
      <nav className="breadcrumbs" aria-label="Serialization breadcrumb">
        {link(`${base}/batches`, 'Batches')}
        {batch && (
          <>
            <span>/</span>
            {link(`${base}/batches/${batch.id}`, batch.lotNumber)}
            <span>/</span>
            {link(`${base}/batches/${batch.id}/serials`, 'Serials')}
          </>
        )}
        {serial && (
          <>
            <span>/</span>
            <span>{serial.serialNumber}</span>
          </>
        )}
      </nav>
      {error && (
        <p className="alert error" role="alert">
          {error}{' '}
          <button
            className="text-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      )}
      {notice && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      <div className="page-heading">
        <div>
          <p className="eyebrow">SERIALIZED UNITS</p>
          <h1>{serial?.serialNumber ?? 'Serials'}</h1>
          <p className="muted">
            {product?.name} {gtin && `· GTIN ${gtin.gtin}`}{' '}
            {batch && `· Lot ${batch.lotNumber}`}
          </p>
        </div>
        {!serialId && batch?.status === 'ACTIVE' && write && (
          <div className="actions">
            <button
              className="secondary"
              onClick={() => {
                single.reset();
                setEditor('single');
              }}
            >
              Create serial
            </button>
            <button
              className="secondary"
              onClick={() => {
                bulk.reset();
                setEditor('bulk');
              }}
            >
              Bulk create
            </button>
          </div>
        )}
      </div>
      {batch && batch.status !== 'ACTIVE' && !serialId && (
        <p className="alert">
          Serial creation requires an active batch. Current batch status:{' '}
          {label(batch.status)}.
        </p>
      )}
      {write && editor === 'single' && (
        <form
          className="domain-form"
          noValidate
          onSubmit={(event) => void create(event)}
        >
          <h2>Create serial</h2>
          <label htmlFor="serial-number">Serial number</label>
          <input
            id="serial-number"
            maxLength={100}
            {...single.register('serialNumber')}
            aria-invalid={!!single.formState.errors.serialNumber}
            aria-describedby="serial-help serial-error"
          />
          <p className="input-help" id="serial-help">
            Case-sensitive text. Leading zeroes are preserved.
          </p>
          <p id="serial-error" className="field-error">
            {single.formState.errors.serialNumber?.message}
          </p>
          <div className="actions">
            <button
              className="primary"
              disabled={single.formState.isSubmitting}
            >
              {single.formState.isSubmitting ? 'Saving…' : 'Create serial'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setEditor(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {write && editor === 'bulk' && (
        <form
          className="domain-form"
          noValidate
          onSubmit={(event) => void createBulk(event)}
        >
          <h2>Bulk create serials</h2>
          <label htmlFor="serial-lines">Serials, one per line</label>
          <textarea
            id="serial-lines"
            rows={8}
            {...bulk.register('lines')}
            aria-invalid={!!bulk.formState.errors.lines}
            aria-describedby="bulk-help bulk-error"
          />
          <p id="bulk-help" className="input-help">
            1–100 distinct serials. Blank lines are ignored. If any serial
            conflicts, none are created.
          </p>
          <p id="bulk-error" className="field-error">
            {bulk.formState.errors.lines?.message}
          </p>
          <div className="actions">
            <button className="primary" disabled={bulk.formState.isSubmitting}>
              {bulk.formState.isSubmitting ? 'Saving…' : 'Create serials'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setEditor(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {serial && (
        <section className="welcome-panel">
          <div className="section-heading">
            <h2>Serialized item profile</h2>
            <span
              className="status-pill capitalize"
              data-status={serial.status}
            >
              {label(serial.status)}
            </span>
          </div>
          <p>
            Parent container:{' '}
            {parent
              ? link(`${base}/aggregates/${parent.id}`, parent.containerCode)
              : 'Unaggregated'}
          </p>
          <dl>
            <div>
              <dt>Serial number</dt>
              <dd>{serial.serialNumber}</dd>
            </div>
            <div>
              <dt>Commissioned</dt>
              <dd>{timestamp(serial.commissionedAt)}</dd>
            </div>
            <div>
              <dt>Decommissioned</dt>
              <dd>{timestamp(serial.decommissionedAt)}</dd>
            </div>
          </dl>
          <div className="actions">
            {(['commission', 'decommission', 'quarantine'] as const)
              .filter(
                (action) =>
                  role &&
                  canExecuteSerialCommand(role, action) &&
                  canTransitionSerial(serial.status, action),
              )
              .map((action) => (
                <button
                  key={action}
                  className="secondary capitalize"
                  disabled={
                    busy ||
                    (action === 'commission' && batch?.status !== 'ACTIVE')
                  }
                  onClick={() => void command(action)}
                >
                  {busy ? 'Updating…' : `${action} serial`}
                </button>
              ))}
          </div>
        </section>
      )}
      {!serialId && batch && (
        <section className="welcome-panel">
          {rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Serial number</th>
                    <th>Status</th>
                    <th>Commissioned</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {link(`${base}/serials/${row.id}`, row.serialNumber)}
                      </td>
                      <td>
                        <span
                          className="status-pill capitalize"
                          data-status={row.status}
                        >
                          {label(row.status)}
                        </span>
                      </td>
                      <td>{timestamp(row.commissionedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <h2>No serialized items yet</h2>
              <p className="muted">
                {write && batch.status === 'ACTIVE'
                  ? 'Create one serial or add up to 100 serials at once.'
                  : 'Serialized items will appear here when added to this batch.'}
              </p>
            </>
          )}
        </section>
      )}
    </section>
  );
}
