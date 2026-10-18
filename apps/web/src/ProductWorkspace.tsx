import { BatchWorkspace } from './BatchWorkspace';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { packagingLevels, type Product, type GTIN } from '@pharma/contracts';
import { authenticatedRequest } from './auth';
import {
  productSchema,
  gtinSchema,
  type ProductForm,
  type GtinForm,
} from './product-forms';
const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
export function ProductWorkspace({
  organizationId,
  admin,
  canWriteBatches,
  path,
  navigate,
}: {
  organizationId: string;
  admin: boolean;
  canWriteBatches: boolean;
  path: string;
  navigate: (path: string) => void;
}) {
  const base = `/organizations/${organizationId}/products`;
  const parts = path.split('/');
  const productId = parts[4];
  const gtinId = parts[6];
  const [rows, setRows] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [gtins, setGtins] = useState<GTIN[]>([]);
  const [gtin, setGtin] = useState<GTIN | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<'product' | 'gtin' | null>(null);
  const [revision, setRevision] = useState(0);
  const productForm = useForm<ProductForm>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: '',
      description: '',
      manufacturerName: '',
      status: 'ACTIVE',
    },
  });
  const gtinForm = useForm<GtinForm>({
    resolver: zodResolver(gtinSchema),
    defaultValues: { gtin: '', packagingLevel: 'EACH', status: 'ACTIVE' },
  });
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setEditor(null);
    setProduct(null);
    setGtin(null);
    setNotice('');
    void (async () => {
      try {
        if (productId) {
          const [detail, codes, code] = await Promise.all([
            authenticatedRequest<Product>(`${base}/${productId}`),
            authenticatedRequest<GTIN[]>(`${base}/${productId}/gtins`),
            gtinId
              ? authenticatedRequest<GTIN>(
                  `${base}/${productId}/gtins/${gtinId}`,
                )
              : Promise.resolve(null),
          ]);
          if (active) {
            setProduct(detail);
            setGtins(codes);
            setGtin(code);
          }
        } else {
          const products = await authenticatedRequest<Product[]>(base);
          if (active) setRows(products);
        }
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load products',
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [base, productId, gtinId, revision]);
  const saveProduct = productForm.handleSubmit(async (values) => {
    setError('');
    try {
      const saved = await authenticatedRequest<Product>(
        productId ? `${base}/${productId}` : base,
        productId ? 'PATCH' : 'POST',
        {
          ...values,
          description: values.description || null,
          manufacturerName: values.manufacturerName || null,
        },
      );
      setEditor(null);
      if (productId) {
        setProduct(saved);
        setNotice('Product saved.');
      } else navigate(`${base}/${saved.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to save product',
      );
    }
  });
  const saveGtin = gtinForm.handleSubmit(async (values) => {
    setError('');
    try {
      const saved = await authenticatedRequest<GTIN>(
        `${base}/${productId}/gtins${gtinId ? `/${gtinId}` : ''}`,
        gtinId ? 'PATCH' : 'POST',
        values,
      );
      setEditor(null);
      if (gtinId) {
        setGtin(saved);
        setGtins((old) =>
          old.map((row) => (row.id === saved.id ? saved : row)),
        );
        setNotice('GTIN saved.');
      } else navigate(`${base}/${productId}/gtins/${saved.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to save GTIN',
      );
    }
  });
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
  if (parts[7] === 'batches' && productId && gtinId)
    return (
      <BatchWorkspace
        organizationId={organizationId}
        canWrite={canWriteBatches}
        productId={productId}
        gtinId={gtinId}
        navigate={navigate}
      />
    );
  if (loading) return <p role="status">Loading products…</p>;
  return (
    <section>
      <nav className="breadcrumbs" aria-label="Product breadcrumb">
        {link(base, 'Products')}
        {product && (
          <>
            <span>/</span>
            {link(`${base}/${product.id}`, product.name)}
          </>
        )}
        {gtin && (
          <>
            <span>/</span>
            <span>{gtin.gtin}</span>
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
          <p className="eyebrow">PRODUCT CATALOG</p>
          <h1>{gtin ? gtin.gtin : product ? product.name : 'Products'}</h1>
          <p className="muted">
            Organization product profiles and packaging identifiers.
          </p>
        </div>
        {admin && (!productId || product) && (
          <button
            className="secondary"
            onClick={() => {
              if (gtin) {
                gtinForm.reset({
                  gtin: gtin.gtin,
                  packagingLevel: gtin.packagingLevel,
                  status: gtin.status,
                });
                setEditor('gtin');
              } else {
                productForm.reset(
                  product
                    ? {
                        name: product.name,
                        description: product.description ?? '',
                        manufacturerName: product.manufacturerName ?? '',
                        status: product.status,
                      }
                    : {
                        name: '',
                        description: '',
                        manufacturerName: '',
                        status: 'ACTIVE',
                      },
                );
                setEditor('product');
              }
            }}
          >
            {gtin ? 'Edit GTIN' : product ? 'Edit product' : 'Create product'}
          </button>
        )}
      </div>
      {admin && editor === 'product' && (
        <form
          className="domain-form"
          onSubmit={(event) => void saveProduct(event)}
          noValidate
        >
          <h2>{product ? 'Edit product' : 'Create product'}</h2>
          <label htmlFor="product-name">Product name</label>
          <input
            id="product-name"
            {...productForm.register('name')}
            aria-invalid={!!productForm.formState.errors.name}
          />
          <p className="field-error">
            {productForm.formState.errors.name?.message}
          </p>
          <label htmlFor="manufacturer">Manufacturer name</label>
          <input
            id="manufacturer"
            {...productForm.register('manufacturerName')}
          />
          <p className="field-error">
            {productForm.formState.errors.manufacturerName?.message}
          </p>
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            rows={4}
            {...productForm.register('description')}
          />
          <p className="field-error">
            {productForm.formState.errors.description?.message}
          </p>
          <label htmlFor="product-status">Status</label>
          <select id="product-status" {...productForm.register('status')}>
            <option>ACTIVE</option>
            <option>INACTIVE</option>
          </select>
          <div className="actions">
            <button
              className="primary"
              disabled={productForm.formState.isSubmitting}
            >
              {productForm.formState.isSubmitting ? 'Saving…' : 'Save product'}
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => setEditor(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {admin && editor === 'gtin' && (
        <form
          className="domain-form"
          onSubmit={(event) => void saveGtin(event)}
          noValidate
        >
          <h2>{gtin ? 'Edit GTIN' : 'Add GTIN'}</h2>
          <label htmlFor="gtin">GTIN</label>
          <input
            id="gtin"
            inputMode="numeric"
            maxLength={14}
            {...gtinForm.register('gtin')}
            aria-invalid={!!gtinForm.formState.errors.gtin}
            aria-describedby="gtin-help gtin-error"
          />
          <p id="gtin-help" className="input-help">
            8, 12, 13 or 14 digits. Stored consistently as 14 digits.
          </p>
          <p id="gtin-error" className="field-error">
            {gtinForm.formState.errors.gtin?.message}
          </p>
          <label htmlFor="packaging">Packaging level</label>
          <select id="packaging" {...gtinForm.register('packagingLevel')}>
            {packagingLevels.map((level) => (
              <option key={level} value={level}>
                {label(level)}
              </option>
            ))}
          </select>
          <label htmlFor="gtin-status">Status</label>
          <select id="gtin-status" {...gtinForm.register('status')}>
            <option>ACTIVE</option>
            <option>INACTIVE</option>
          </select>
          <div className="actions">
            <button
              className="primary"
              disabled={gtinForm.formState.isSubmitting}
            >
              {gtinForm.formState.isSubmitting ? 'Saving…' : 'Save GTIN'}
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => setEditor(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {!productId && !error && (
        <section className="welcome-panel">
          {rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Manufacturer</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{link(`${base}/${row.id}`, row.name)}</td>
                      <td>{row.manufacturerName ?? '—'}</td>
                      <td className="capitalize">{label(row.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <h2>No products yet</h2>
              <p className="muted">
                {admin
                  ? 'Create your first product to add packaging GTINs.'
                  : 'Products will appear here when your administrator adds them.'}
              </p>
            </>
          )}
        </section>
      )}
      {product && (
        <section className="welcome-panel">
          <h2>{gtin ? 'GTIN profile' : 'Product profile'}</h2>
          <dl>
            {gtin ? (
              <>
                <div>
                  <dt>Packaging level</dt>
                  <dd className="capitalize">{label(gtin.packagingLevel)}</dd>
                </div>
                <div>
                  <dt>Product</dt>
                  <dd>{product.name}</dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>Manufacturer</dt>
                  <dd>{product.manufacturerName ?? 'Not provided'}</dd>
                </div>
                <div>
                  <dt>Description</dt>
                  <dd>{product.description ?? 'Not provided'}</dd>
                </div>
              </>
            )}
            <div>
              <dt>Status</dt>
              <dd className="capitalize">
                {label(gtin?.status ?? product.status)}
              </dd>
            </div>
          </dl>
        </section>
      )}
      {product && gtin && (
        <section className="welcome-panel">
          <h2>Batches / lots</h2>
          <p className="muted">
            Manage manufacturing lots for this packaging identifier.
          </p>
          {link(
            `${base}/${product.id}/gtins/${gtin.id}/batches`,
            'View batches',
          )}
        </section>
      )}
      {product && !gtinId && (
        <section className="welcome-panel">
          <div className="section-heading">
            <h2>
              GTINs <span className="count">{gtins.length}</span>
            </h2>
            {admin && (
              <button
                className="secondary"
                onClick={() => {
                  gtinForm.reset({
                    gtin: '',
                    packagingLevel: 'EACH',
                    status: 'ACTIVE',
                  });
                  setEditor('gtin');
                }}
              >
                Add GTIN
              </button>
            )}
          </div>
          {gtins.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>GTIN</th>
                    <th>Packaging level</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {gtins.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {link(
                          `${base}/${product.id}/gtins/${row.id}`,
                          row.gtin,
                        )}
                      </td>
                      <td className="capitalize">
                        {label(row.packagingLevel)}
                      </td>
                      <td className="capitalize">{label(row.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">
              No GTINs assigned.{' '}
              {admin && 'Add a GS1 identifier for a packaging level.'}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
