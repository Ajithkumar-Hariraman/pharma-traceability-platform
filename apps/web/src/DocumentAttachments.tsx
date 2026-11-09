import { useEffect, useState } from 'react';
import type { SupportingDocument } from '@pharma/contracts';
import { authenticatedRequest } from './auth';
const categories = {
  PRODUCT: ['REGULATORY_CERTIFICATE', 'AUTHORIZATION', 'SPECIFICATION'],
  RECALL: ['RECALL_NOTICE', 'INVESTIGATION_EVIDENCE', 'REGULATORY_DOCUMENT'],
  SHIPMENT: ['PACKING_DOCUMENT', 'SHIPPING_MANIFEST', 'RECEIVING_EVIDENCE'],
};
export function DocumentAttachments({
  base,
  domain,
  write,
  admin,
}: {
  base: string;
  domain: keyof typeof categories;
  write: boolean;
  admin: boolean;
}) {
  const [rows, setRows] = useState<SupportingDocument[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [category, setCategory] = useState(categories[domain][0]!);
  const [pending, setPending] = useState<string | null>(null);
  const path = `${base}/documents`;
  useEffect(() => {
    let active = true;
    setLoading(true);
    void authenticatedRequest<SupportingDocument[]>(path)
      .then((data) => {
        if (active) setRows(data);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, revision]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setRevision((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Document operation failed');
    } finally {
      setBusy(false);
    }
  }
  async function finalize(id: string) {
    await authenticatedRequest(`${path}/${id}/finalize`, 'POST', {});
    setPending(null);
  }
  return (
    <section className="card">
      <h3>Documents and evidence</h3>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">Loading documents…</p>
      ) : rows.length === 0 ? (
        <p>No documents attached.</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              {row.originalFileName} ·{' '}
              {row.category.toLowerCase().replaceAll('_', ' ')} ·{' '}
              {new Date(row.createdAt).toLocaleString()}{' '}
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await authenticatedRequest<{ url: string }>(
                      `${path}/${row.id}/download`,
                    );
                    window.location.assign(result.url);
                  })
                }
              >
                Download
              </button>
              {admin && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete ${row.originalFileName}?`))
                      void action(async () => {
                        await authenticatedRequest(
                          `${path}/${row.id}`,
                          'DELETE',
                        );
                      });
                  }}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {write && (
        <>
          <label>
            Document category
            <select
              disabled={busy}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories[domain].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Choose document (PDF, PNG, JPEG, CSV; default limit 10 MiB)
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.csv"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                void action(async () => {
                  if (file.size > 104857600) throw new Error('File too large');
                  const digest = new Uint8Array(
                    await crypto.subtle.digest(
                      'SHA-256',
                      await file.arrayBuffer(),
                    ),
                  );
                  const checksum = btoa(String.fromCharCode(...digest));
                  const result = await authenticatedRequest<{
                    document: SupportingDocument;
                    url: string;
                    headers: Record<string, string>;
                  }>(`${path}/uploads`, 'POST', {
                    originalFileName: file.name,
                    contentType: file.type,
                    size: file.size,
                    checksum,
                    category,
                  });
                  setPending(result.document.id);
                  const response = await fetch(result.url, {
                    method: 'PUT',
                    body: file,
                    headers: result.headers,
                    credentials: 'omit',
                  });
                  if (!response.ok)
                    throw new Error(
                      'Upload failed; choose the file again to restart.',
                    );
                  await finalize(result.document.id);
                });
              }}
            />
          </label>
          {pending && (
            <button
              disabled={busy}
              onClick={() => void action(() => finalize(pending))}
            >
              Retry finalization
            </button>
          )}
        </>
      )}
      {busy && <p role="status">Processing document…</p>}
    </section>
  );
}
