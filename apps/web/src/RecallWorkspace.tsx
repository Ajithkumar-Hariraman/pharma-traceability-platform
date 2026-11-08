import { useEffect, useState } from 'react';
import {
  recallStatuses,
  recallSeverities,
  type Recall,
  type Product,
  type Batch,
  type GTIN,
  type OrganizationRole,
} from '@pharma/contracts';
import { authenticatedRequest } from './auth';
type Page = { items: Recall[]; total: number; page: number; pageSize: number };
export function RecallWorkspace({
  organizationId,
  recallId,
  role,
  navigate,
}: {
  organizationId: string;
  recallId?: string;
  role?: OrganizationRole;
  navigate: (path: string) => void;
}) {
  const base = `/organizations/${organizationId}`;
  const [rows, setRows] = useState<Page>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
  });
  const [detail, setDetail] = useState<Recall | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [gtins, setGtins] = useState<GTIN[]>([]);
  const [status, setStatus] = useState('');
  const [filterProduct, setFilterProduct] = useState('');
  const [filterBatch, setFilterBatch] = useState('');
  const [page, setPage] = useState(1);
  const [productId, setProductId] = useState('');
  const [gtinId, setGtinId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const creating = recallId === 'new';
  const writable = role === 'ORG_ADMIN' || role === 'OPERATOR';
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({
      page: String(page),
      pageSize: '25',
      ...(status ? { status } : {}),
      ...(filterProduct ? { productId: filterProduct } : {}),
      ...(filterBatch ? { batchId: filterBatch } : {}),
    });
    Promise.all([
      authenticatedRequest<Product[]>(`${base}/products`),
      authenticatedRequest<Batch[]>(`${base}/batches`),
      recallId && !creating
        ? authenticatedRequest<Recall>(`${base}/recalls/${recallId}`)
        : authenticatedRequest<Page>(`${base}/recalls?${query}`),
    ])
      .then(([p, b, result]) => {
        if (!live) return;
        setProducts(p);
        setBatches(b);
        if ('items' in result) setRows(result);
        else setDetail(result);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [
    base,
    recallId,
    creating,
    page,
    status,
    filterProduct,
    filterBatch,
    revision,
  ]);
  useEffect(() => {
    let live = true;
    setGtins([]);
    if (productId)
      void authenticatedRequest<GTIN[]>(`${base}/products/${productId}/gtins`)
        .then((rows) => {
          if (live) setGtins(rows);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [base, productId]);
  const name = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const scope = (r: Recall) =>
    `${name(r.productId)} · ${r.batchId ? `Batch ${batches.find((b) => b.id === r.batchId)?.lotNumber ?? r.batchId}` : r.gtinId ? 'GTIN scope' : 'All product items'}`;
  async function command(action: string) {
    if (
      !detail ||
      !window.confirm(
        `${action[0]!.toUpperCase() + action.slice(1)} recall ${detail.recallNumber}? ${action === 'activate' ? 'Affected items will report RECALLED during verification.' : 'This transition cannot be undone.'}`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      setDetail(
        await authenticatedRequest<Recall>(
          `${base}/recalls/${detail.id}/${action}`,
          'POST',
          {},
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update recall');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PATIENT SAFETY / RECALL MANAGEMENT</p>
          <h1>
            {creating
              ? 'Create recall'
              : detail && recallId
                ? detail.recallNumber
                : 'Recalls'}
          </h1>
          <p className="muted">
            Define the affected scope, activate a recall, and track its
            lifecycle.
          </p>
        </div>
        {!recallId && writable && (
          <button
            className="primary compact"
            onClick={() => navigate(`${base}/recalls/new`)}
          >
            Create recall
          </button>
        )}
        {recallId && (
          <button
            className="secondary"
            onClick={() => navigate(`${base}/recalls`)}
          >
            All recalls
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="alert error">
          {error}{' '}
          <button onClick={() => setRevision((r) => r + 1)}>Retry</button>
        </p>
      )}
      {loading ? (
        <p role="status">Loading recalls…</p>
      ) : creating ? (
        <form
          className="domain-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            setError('');
            try {
              const row = await authenticatedRequest<Recall>(
                `${base}/recalls`,
                'POST',
                {
                  recallNumber: form.get('recallNumber'),
                  title: form.get('title'),
                  reason: form.get('reason'),
                  severity: form.get('severity'),
                  productId,
                  ...(gtinId ? { gtinId } : {}),
                  ...(batchId ? { batchId } : {}),
                },
              );
              navigate(`${base}/recalls/${row.id}`);
            } catch (e) {
              setError(
                e instanceof Error ? e.message : 'Unable to create recall',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Recall number
            <input name="recallNumber" required maxLength={100} />
          </label>
          <label>
            Title
            <input name="title" required maxLength={200} />
          </label>
          <label>
            Product
            <select
              required
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                setGtinId('');
                setBatchId('');
              }}
            >
              <option value="">Select product</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            GTIN
            <select
              value={gtinId}
              onChange={(e) => {
                setGtinId(e.target.value);
                setBatchId('');
              }}
              disabled={!productId}
            >
              <option value="">All GTINs under product</option>
              {gtins.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.gtin}
                </option>
              ))}
            </select>
          </label>
          <label>
            Batch
            <select
              value={batchId}
              onChange={(e) => setBatchId(e.target.value)}
              disabled={!productId}
            >
              <option value="">All batches in selected scope</option>
              {batches
                .filter(
                  (b) =>
                    b.productId === productId &&
                    (!gtinId || b.gtinId === gtinId),
                )
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.lotNumber}
                  </option>
                ))}
            </select>
          </label>
          <p className="input-help">
            A selected batch limits the recall to that batch. Without a batch,
            the recall covers the selected GTIN or the whole product.
          </p>
          <label>
            Classification
            <select name="severity">
              {recallSeverities.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Reason
            <textarea name="reason" required maxLength={4000} rows={4} />
          </label>
          <button className="primary" disabled={busy || !writable}>
            {busy ? 'Saving…' : 'Save draft'}
          </button>
        </form>
      ) : recallId && detail ? (
        <article className="welcome-panel">
          <span className="status-pill">{detail.status}</span>
          <h2>{detail.title}</h2>
          <p>{scope(detail)}</p>
          <dl>
            <dt>Reason</dt>
            <dd>{detail.reason}</dd>
            <dt>Classification</dt>
            <dd>{detail.severity}</dd>
            <dt>Created</dt>
            <dd>{new Date(detail.createdAt).toLocaleString()}</dd>
            <dt>Initiated</dt>
            <dd>
              {detail.initiatedAt
                ? new Date(detail.initiatedAt).toLocaleString()
                : 'Not activated'}
            </dd>
            <dt>Closed</dt>
            <dd>
              {detail.closedAt
                ? new Date(detail.closedAt).toLocaleString()
                : '—'}
            </dd>
          </dl>
          <div className="actions">
            {writable && detail.status === 'DRAFT' && (
              <>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void command('activate')}
                >
                  Activate recall
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void command('cancel')}
                >
                  Cancel draft
                </button>
              </>
            )}
            {writable && detail.status === 'ACTIVE' && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void command('close')}
              >
                Close recall
              </button>
            )}
            <a
              href={`${base}/trace${detail.batchId ? `/batches/${detail.batchId}` : ''}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(
                  `${base}/trace${detail.batchId ? `/batches/${detail.batchId}` : ''}`,
                );
              }}
            >
              View traceability history
            </a>
          </div>
        </article>
      ) : (
        <>
          <div className="actions">
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
                {recallStatuses.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Product
              <select
                value={filterProduct}
                onChange={(e) => {
                  setFilterProduct(e.target.value);
                  setFilterBatch('');
                  setPage(1);
                }}
              >
                <option value="">All products</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Batch
              <select
                value={filterBatch}
                onChange={(e) => {
                  setFilterBatch(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All batches</option>
                {batches
                  .filter(
                    (b) => !filterProduct || b.productId === filterProduct,
                  )
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.lotNumber}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recall number</th>
                  <th>Title</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th>Initiated</th>
                </tr>
              </thead>
              <tbody>
                {rows.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a
                        href={`${base}/recalls/${r.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`${base}/recalls/${r.id}`);
                        }}
                      >
                        {r.recallNumber}
                      </a>
                    </td>
                    <td>{r.title}</td>
                    <td>{scope(r)}</td>
                    <td>
                      <span className="status-pill">{r.status}</span>
                    </td>
                    <td>
                      {r.initiatedAt
                        ? new Date(r.initiatedAt).toLocaleDateString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.items.length && <p>No recalls match these filters.</p>}
          <div className="actions">
            <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span>
              Page {page} · {rows.total} recalls
            </span>
            <button
              disabled={page * 25 >= rows.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
