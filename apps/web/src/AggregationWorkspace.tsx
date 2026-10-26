import { useEffect, useState } from 'react';
import {
  type AggregateContainer,
  type AggregateHierarchy,
  type OrganizationRole,
  canWriteOrganizationResource,
  aggregatePackagingLevels,
} from '@pharma/contracts';
import { authenticatedRequest } from './auth';
export function AggregationWorkspace({
  organizationId,
  aggregateId,
  role,
  navigate,
}: {
  organizationId: string;
  aggregateId?: string;
  role?: OrganizationRole;
  navigate: (path: string) => void;
}) {
  const base = `/organizations/${organizationId}/aggregates`;
  const [rows, setRows] = useState<AggregateContainer[]>([]);
  const [tree, setTree] = useState<AggregateHierarchy | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const write = !!role && canWriteOrganizationResource(role, 'aggregation');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setTree(null);
    setError('');
    void Promise.all([
      authenticatedRequest<AggregateContainer[]>(base),
      aggregateId
        ? authenticatedRequest<AggregateHierarchy>(
            `${base}/${aggregateId}/hierarchy`,
          )
        : Promise.resolve(null),
    ])
      .then(([list, hierarchy]) => {
        if (active) {
          setRows(list);
          setTree(hierarchy);
        }
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : 'Unable to load packaging');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base, aggregateId, revision]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      await authenticatedRequest(path, method, body);
      setRevision((v) => v + 1);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update packaging');
      return false;
    } finally {
      setBusy(false);
    }
  }
  function link(row: AggregateContainer) {
    return (
      <a
        href={`${base}/${row.id}`}
        onClick={(e) => {
          e.preventDefault();
          navigate(`${base}/${row.id}`);
        }}
      >
        {row.containerCode}
      </a>
    );
  }
  function branch(node: AggregateHierarchy) {
    return (
      <li key={node.id}>
        {link(node)} <span className="status-pill">{node.packagingLevel}</span>{' '}
        · {node.status}
        <ul>
          {node.items.map((item) => (
            <li key={item.id}>
              <a href={`/organizations/${organizationId}/serials/${item.id}`}>
                {item.serialNumber}
              </a>{' '}
              · EACH · {item.status}
              {write && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove serial ${item.serialNumber} from ${node.containerCode}?`,
                      )
                    )
                      void mutate(
                        `${base}/${node.id}/items/${item.id}`,
                        'DELETE',
                      );
                  }}
                >
                  Disaggregate
                </button>
              )}
            </li>
          ))}
          {node.children.map((child) => (
            <li key={child.id}>
              {write && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${child.containerCode} from ${node.containerCode}? Its contents stay together.`,
                      )
                    )
                      void mutate(
                        `${base}/${node.id}/containers/${child.id}`,
                        'DELETE',
                      );
                  }}
                >
                  Disaggregate {child.containerCode}
                </button>
              )}
              <ul>{branch(child)}</ul>
            </li>
          ))}
        </ul>
      </li>
    );
  }
  return (
    <section>
      <nav>
        <a
          href={base}
          onClick={(e) => {
            e.preventDefault();
            navigate(base);
          }}
        >
          Aggregation
        </a>
      </nav>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PACKAGING HIERARCHY</p>
          <h1>{tree?.containerCode ?? 'Containers'}</h1>
          <p className="muted">
            Build packaging from commissioned units through inner packs, cases
            and pallets.
          </p>
        </div>
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}{' '}
          <button onClick={() => setRevision((v) => v + 1)}>Retry</button>
        </p>
      )}
      {loading && <p role="status">Loading packaging…</p>}
      {!aggregateId && write && (
        <form
          className="domain-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const values = new FormData(form);
            void mutate(base, 'POST', {
              containerCode: values.get('code'),
              packagingLevel: values.get('level'),
            }).then((saved) => {
              if (saved) form.reset();
            });
          }}
        >
          <h2>Create container</h2>
          <label htmlFor="container-code">Container code</label>
          <input id="container-code" name="code" required maxLength={100} />
          <label htmlFor="packaging-level">Packaging level</label>
          <select id="packaging-level" name="level">
            {aggregatePackagingLevels.map((level) => (
              <option key={level}>{level}</option>
            ))}
          </select>
          <button className="primary" disabled={busy}>
            Create container
          </button>
        </form>
      )}
      {!aggregateId && !loading && (
        <div className="welcome-panel">
          {rows.length ? (
            <table>
              <thead>
                <tr>
                  <th>Container</th>
                  <th>Level</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{link(row)}</td>
                    <td>
                      <span className="status-pill">{row.packagingLevel}</span>
                    </td>
                    <td>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No containers yet.</p>
          )}
        </div>
      )}
      {tree && (
        <>
          <section className="welcome-panel">
            <h2>Hierarchy</h2>
            <ul>{branch(tree)}</ul>
            {!tree.items.length && !tree.children.length && (
              <p>This container is empty.</p>
            )}
          </section>
          {write && tree.status === 'ACTIVE' && (
            <form
              className="domain-form"
              onSubmit={(e) => {
                e.preventDefault();
                const values = new FormData(e.currentTarget);
                const kind = String(values.get('kind'));
                void mutate(
                  `${base}/${tree.id}/${kind}`,
                  'POST',
                  kind === 'items'
                    ? { serializedItemId: values.get('child') }
                    : { childContainerId: values.get('child') },
                );
              }}
            >
              <h2>Add child</h2>
              <label htmlFor="child-kind">Child type</label>
              <select id="child-kind" name="kind">
                <option value="items">Commissioned serialized item</option>
                <option value="containers">Container</option>
              </select>
              <label htmlFor="child-id">Child UUID</label>
              <input
                id="child-id"
                name="child"
                required
                pattern="[a-fA-F0-9-]{36}"
              />
              <p className="input-help">
                Move a child by disaggregating it from its current parent, then
                adding it here.
              </p>
              <button className="primary" disabled={busy}>
                Aggregate child
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
