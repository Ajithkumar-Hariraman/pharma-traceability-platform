import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  batchStatuses,
  type Batch,
  type Product,
  type GTIN,
} from '@pharma/contracts';
import { authenticatedRequest } from './auth';
import { batchSchema, type BatchForm } from './batch-forms';
const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const dateLabel = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${value}T00:00:00Z`))
    : 'Not provided';
export function BatchWorkspace({
  organizationId,
  canWrite,
  productId,
  gtinId,
  batchId,
  navigate,
}: {
  organizationId: string;
  canWrite: boolean;
  productId?: string;
  gtinId?: string;
  batchId?: string;
  navigate: (path: string) => void;
}) {
  const base = `/organizations/${organizationId}`;
  const listPath =
    productId && gtinId
      ? `${base}/products/${productId}/gtins/${gtinId}/batches`
      : `${base}/batches`;
  const [rows, setRows] = useState<Batch[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [gtin, setGtin] = useState<GTIN | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);
  const form = useForm<BatchForm>({
    resolver: zodResolver(batchSchema),
    defaultValues: {
      lotNumber: '',
      manufactureDate: '',
      expiryDate: '',
      status: 'ACTIVE',
    },
  });
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setNotice('');
    setEditing(false);
    setBatch(null);
    setProduct(null);
    setGtin(null);
    void (async () => {
      try {
        const detail = batchId
          ? await authenticatedRequest<Batch>(`${base}/batches/${batchId}`)
          : null;
        const p = detail?.productId ?? productId;
        const g = detail?.gtinId ?? gtinId;
        const [products, codes, batches] = await Promise.all([
          p
            ? authenticatedRequest<Product>(`${base}/products/${p}`)
            : Promise.resolve(null),
          p && g
            ? authenticatedRequest<GTIN>(`${base}/products/${p}/gtins/${g}`)
            : Promise.resolve(null),
          detail
            ? Promise.resolve([])
            : authenticatedRequest<Batch[]>(listPath),
        ]);
        if (active) {
          setBatch(detail);
          setProduct(products);
          setGtin(codes);
          setRows(batches);
        }
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load batches',
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [base, listPath, productId, gtinId, batchId, revision]);
  const save = form.handleSubmit(async (values) => {
    setError('');
    try {
      const result = await authenticatedRequest<Batch>(
        batch ? `${base}/batches/${batch.id}` : listPath,
        batch ? 'PATCH' : 'POST',
        {
          ...values,
          manufactureDate: values.manufactureDate || null,
          expiryDate: values.expiryDate || null,
        },
      );
      setEditing(false);
      if (batch) {
        setBatch(result);
        setNotice('Batch saved.');
      } else navigate(`${base}/batches/${result.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to save batch',
      );
    }
  });
  function link(path: string, text: string) {
    return (
      <a
        href={path}
        onClick={(event) => {
          event.preventDefault();
          navigate(path);
        }}
      >
        {text}
      </a>
    );
  }
  if (loading) return <p role="status">Loading batches…</p>;
  return (
    <section>
      <nav className="breadcrumbs" aria-label="Batch breadcrumb">
        {link(`${base}/batches`, 'Batches')}
        {product && (
          <>
            <span>/</span>
            {link(`${base}/products/${product.id}`, product.name)}
          </>
        )}
        {product && gtin && (
          <>
            <span>/</span>
            {link(`${base}/products/${product.id}/gtins/${gtin.id}`, gtin.gtin)}
          </>
        )}
        {batch && (
          <>
            <span>/</span>
            <span>{batch.lotNumber}</span>
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
          <p className="eyebrow">BATCH / LOT MANAGEMENT</p>
          <h1>{batch ? batch.lotNumber : 'Batches'}</h1>
          {batch && (
            <a href={`${base}/trace/batches/${batch.id}`}>Trace History</a>
          )}
          <p className="muted">
            {product
              ? `${product.name} · GTIN ${gtin?.gtin ?? ''}`
              : 'Organization lots and lifecycle status.'}
          </p>
        </div>
        {canWrite && !error && (batch || (product && gtin)) && (
          <button
            className="secondary"
            onClick={() => {
              form.reset(
                batch
                  ? {
                      lotNumber: batch.lotNumber,
                      manufactureDate: batch.manufactureDate ?? '',
                      expiryDate: batch.expiryDate ?? '',
                      status: batch.status,
                    }
                  : {
                      lotNumber: '',
                      manufactureDate: '',
                      expiryDate: '',
                      status: 'ACTIVE',
                    },
              );
              setEditing(true);
            }}
          >
            {batch ? 'Edit batch' : 'Create batch'}
          </button>
        )}
      </div>
      {canWrite && editing && (
        <form
          className="domain-form"
          noValidate
          onSubmit={(event) => void save(event)}
        >
          <h2>{batch ? 'Edit batch' : 'Create batch'}</h2>
          <label htmlFor="lot-number">Lot number</label>
          <input
            id="lot-number"
            {...form.register('lotNumber')}
            aria-invalid={!!form.formState.errors.lotNumber}
            aria-describedby="lot-error"
          />
          <p id="lot-error" className="field-error">
            {form.formState.errors.lotNumber?.message}
          </p>
          <label htmlFor="manufacture-date">Manufacture date (optional)</label>
          <input
            id="manufacture-date"
            type="date"
            {...form.register('manufactureDate')}
            aria-invalid={!!form.formState.errors.manufactureDate}
            aria-describedby="manufacture-error"
          />
          <p id="manufacture-error" className="field-error">
            {form.formState.errors.manufactureDate?.message}
          </p>
          <label htmlFor="expiry-date">Expiry date (optional)</label>
          <input
            id="expiry-date"
            type="date"
            {...form.register('expiryDate')}
            aria-invalid={!!form.formState.errors.expiryDate}
            aria-describedby="expiry-error"
          />
          <p id="expiry-error" className="field-error">
            {form.formState.errors.expiryDate?.message}
          </p>
          <label htmlFor="batch-status">Status</label>
          <select id="batch-status" {...form.register('status')}>
            {batchStatuses.map((status) => (
              <option key={status} value={status}>
                {label(status)}
              </option>
            ))}
          </select>
          <div className="actions">
            <button className="primary" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Saving…' : 'Save batch'}
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {batch && (
        <section className="welcome-panel">
          <h2>Batch profile</h2>
          <span className="status-pill capitalize" data-status={batch.status}>
            {label(batch.status)}
          </span>
          <dl>
            <div>
              <dt>Product</dt>
              <dd>{product?.name ?? batch.productId}</dd>
            </div>
            <div>
              <dt>GTIN</dt>
              <dd>{gtin?.gtin ?? batch.gtinId}</dd>
            </div>
            <div>
              <dt>Manufacture date</dt>
              <dd>{dateLabel(batch.manufactureDate)}</dd>
            </div>
            <div>
              <dt>Expiry date</dt>
              <dd>{dateLabel(batch.expiryDate)}</dd>
            </div>
          </dl>
          {link(
            `${base}/products/${batch.productId}/gtins/${batch.gtinId}/batches`,
            'All batches for this GTIN',
          )}
        </section>
      )}
      {batch && (
        <section className="welcome-panel">
          <h2>Serialized items</h2>
          <p className="muted">
            Create serials and manage commissioning for this lot.
          </p>
          {link(`${base}/batches/${batch.id}/serials`, 'View serials')}
        </section>
      )}
      {!batchId && !error && (
        <section className="welcome-panel">
          {rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Lot number</th>
                    <th>Status</th>
                    <th>Manufacture date</th>
                    <th>Expiry date</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {link(`${base}/batches/${row.id}`, row.lotNumber)}
                      </td>
                      <td>
                        <span
                          className="status-pill capitalize"
                          data-status={row.status}
                        >
                          {label(row.status)}
                        </span>
                      </td>
                      <td>{dateLabel(row.manufactureDate)}</td>
                      <td>{dateLabel(row.expiryDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <h2>No batches yet</h2>
              <p className="muted">
                {canWrite
                  ? 'Open a product GTIN to create its first batch.'
                  : 'Batches will appear here when an administrator or operator adds them.'}
              </p>
              {link(`${base}/products`, 'Browse products')}
            </>
          )}
        </section>
      )}
    </section>
  );
}
