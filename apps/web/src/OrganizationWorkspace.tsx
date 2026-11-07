import { TraceWorkspace } from './TraceWorkspace';
import { AggregationWorkspace } from './AggregationWorkspace';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Organization, Facility, Membership } from '@pharma/contracts';
import { SerialWorkspace } from './SerialWorkspace';
import { BatchWorkspace } from './BatchWorkspace';
import { canWriteOrganizationResource } from '@pharma/contracts';
import { ProductWorkspace } from './ProductWorkspace';
import { authenticatedRequest } from './auth';
import {
  organizationSchema,
  facilitySchema,
  type OrganizationForm,
  type FacilityForm,
} from './organization-forms';
const label = (value: string) => value.toLowerCase().replaceAll('_', ' ');
export function OrganizationWorkspace({ userId }: { userId: string }) {
  const [path, setPath] = useState(window.location.pathname);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [facility, setFacility] = useState<Facility | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [creatingFacility, setCreatingFacility] = useState(false);
  const [editingOrg, setEditingOrg] = useState(false);
  const [editingFacility, setEditingFacility] = useState(false);
  const orgForm = useForm<OrganizationForm>({
    resolver: zodResolver(organizationSchema),
    defaultValues: { legalName: '' },
  });
  const facilityForm = useForm<FacilityForm>({
    resolver: zodResolver(facilitySchema),
    defaultValues: { name: '', type: 'MANUFACTURER', gln: '' },
  });
  const parts = path.split('/').filter(Boolean);
  const organizationId = parts[0] === 'organizations' ? parts[1] : undefined;
  const facilityId = parts[2] === 'facilities' ? parts[3] : undefined;
  const admin = memberships.some(
    (member) => member.userId === userId && member.role === 'ORG_ADMIN',
  );
  const role = memberships.find((member) => member.userId === userId)?.role;
  const navigate = (next: string) => {
    window.history.pushState({}, '', next);
    setPath(next);
    setCreatingOrg(false);
    setCreatingFacility(false);
    setEditingOrg(false);
    setEditingFacility(false);
    setNotice('');
  };
  useEffect(() => {
    const pop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (organizationId) {
        const [org, rows, members] = await Promise.all([
          authenticatedRequest<Organization>(
            `/organizations/${organizationId}`,
          ),
          authenticatedRequest<Facility[]>(
            `/organizations/${organizationId}/facilities`,
          ),
          authenticatedRequest<Membership[]>(
            `/organizations/${organizationId}/memberships`,
          ),
        ]);
        const detail = facilityId
          ? await authenticatedRequest<Facility>(
              `/organizations/${organizationId}/facilities/${facilityId}`,
            )
          : null;
        setOrganization(org);
        setFacilities(rows);
        setMemberships(members);
        setFacility(detail);
      } else {
        setOrganizations(
          await authenticatedRequest<Organization[]>('/organizations'),
        );
        setOrganization(null);
        setFacility(null);
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to load workspace',
      );
      setOrganization(null);
      setFacility(null);
    } finally {
      setLoading(false);
    }
  }, [organizationId, facilityId]);
  useEffect(() => {
    void load();
  }, [load]);
  const saveOrg = orgForm.handleSubmit(async (values) => {
    setError('');
    try {
      if (editingOrg && organization) {
        await authenticatedRequest(
          `/organizations/${organization.id}`,
          'PATCH',
          values,
        );
        setEditingOrg(false);
        setNotice('Organization updated.');
        await load();
      } else {
        const created = await authenticatedRequest<Organization>(
          '/organizations',
          'POST',
          values,
        );
        orgForm.reset();
        navigate(`/organizations/${created.id}`);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save organization',
      );
    }
  });
  const saveFacility = facilityForm.handleSubmit(async (values) => {
    setError('');
    try {
      const input = { ...values, gln: values.gln || null };
      if (editingFacility && facility) {
        await authenticatedRequest(
          `/organizations/${organizationId}/facilities/${facility.id}`,
          'PATCH',
          input,
        );
        setEditingFacility(false);
        setNotice('Facility updated.');
        await load();
      } else {
        const created = await authenticatedRequest<Facility>(
          `/organizations/${organizationId}/facilities`,
          'POST',
          input,
        );
        setCreatingFacility(false);
        facilityForm.reset();
        navigate(`/organizations/${organizationId}/facilities/${created.id}`);
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to save facility',
      );
    }
  });
  const orgEditor = (
    <form
      className="domain-form"
      onSubmit={(event) => void saveOrg(event)}
      noValidate
    >
      <h2>{editingOrg ? 'Edit organization' : 'Create organization'}</h2>
      <label htmlFor="legal-name">Legal name</label>
      <input
        id="legal-name"
        {...orgForm.register('legalName')}
        aria-invalid={!!orgForm.formState.errors.legalName}
        aria-describedby="legal-error"
      />
      <p id="legal-error" className="field-error">
        {orgForm.formState.errors.legalName?.message}
      </p>
      <div className="actions">
        <button className="primary" disabled={orgForm.formState.isSubmitting}>
          {orgForm.formState.isSubmitting ? 'Saving…' : 'Save organization'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setCreatingOrg(false);
            setEditingOrg(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
  const facilityEditor = (
    <form
      className="domain-form"
      onSubmit={(event) => void saveFacility(event)}
      noValidate
    >
      <h2>{editingFacility ? 'Edit facility' : 'Create facility'}</h2>
      <label htmlFor="facility-name">Facility name</label>
      <input
        id="facility-name"
        {...facilityForm.register('name')}
        aria-invalid={!!facilityForm.formState.errors.name}
        aria-describedby="facility-error"
      />
      <p id="facility-error" className="field-error">
        {facilityForm.formState.errors.name?.message}
      </p>
      <label htmlFor="facility-type">Facility type</label>
      <select id="facility-type" {...facilityForm.register('type')}>
        <option value="MANUFACTURER">Manufacturer</option>
        <option value="DISTRIBUTOR">Distributor</option>
        <option value="WHOLESALER">Wholesaler</option>
        <option value="DISPENSER">Dispenser</option>
      </select>
      <label htmlFor="gln">
        GLN <span className="muted">(optional)</span>
      </label>
      <input
        id="gln"
        inputMode="numeric"
        maxLength={13}
        {...facilityForm.register('gln')}
        aria-invalid={!!facilityForm.formState.errors.gln}
        aria-describedby="gln-help gln-error"
      />
      <p id="gln-help" className="input-help">
        13-digit Global Location Number.
      </p>
      <p id="gln-error" className="field-error">
        {facilityForm.formState.errors.gln?.message}
      </p>
      <div className="actions">
        <button
          className="primary"
          disabled={facilityForm.formState.isSubmitting}
        >
          {facilityForm.formState.isSubmitting ? 'Saving…' : 'Save facility'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setCreatingFacility(false);
            setEditingFacility(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
  return (
    <main className="dashboard">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <a
          href="/organizations"
          onClick={(event) => {
            event.preventDefault();
            navigate('/organizations');
          }}
        >
          Organizations
        </a>
        {organization && (
          <>
            <span>/</span>
            <a
              href={`/organizations/${organization.id}`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/organizations/${organization.id}`);
              }}
            >
              {organization.legalName}
            </a>
          </>
        )}
        {facility && (
          <>
            <span>/</span>
            <span>{facility.name}</span>
          </>
        )}
      </nav>
      {error && (
        <p role="alert" className="alert error">
          {error}{' '}
          <button className="text-button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="alert success">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading workspace…</p>
      ) : !organizationId ? (
        <>
          <div className="page-heading">
            <div>
              <p className="eyebrow">YOUR CONNECTED WORKSPACE</p>
              <h1>Organizations</h1>
              <p className="muted">
                Manage your organizations and their pharmaceutical facilities.
              </p>
            </div>
            <button
              className="primary compact"
              onClick={() => {
                orgForm.reset({ legalName: '' });
                setCreatingOrg(true);
              }}
            >
              Create organization
            </button>
          </div>
          {creatingOrg && orgEditor}
          <section className="organization-grid">
            {organizations.map((org) => (
              <a
                className="organization-card"
                href={`/organizations/${org.id}`}
                key={org.id}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(`/organizations/${org.id}`);
                }}
              >
                <span className="status-pill">{label(org.status)}</span>
                <h2>{org.legalName}</h2>
                <p className="muted">View facilities and memberships →</p>
              </a>
            ))}
          </section>
          {!organizations.length && !error && (
            <section className="welcome-panel">
              <h2>Your workspace starts here.</h2>
              <p>
                Create an organization to become its administrator and add your
                first facility.
              </p>
            </section>
          )}
        </>
      ) : organization ? (
        <>
          <nav className="actions" aria-label="Organization navigation">
            <a
              href={`/organizations/${organization.id}`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/organizations/${organization.id}`);
              }}
            >
              Facilities & memberships
            </a>

            <a
              href={`/organizations/${organization.id}/products`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/organizations/${organization.id}/products`);
              }}
            >
              Products
            </a>

            <a
              href={`/organizations/${organization.id}/batches`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/organizations/${organization.id}/batches`);
              }}
            >
              Batches
            </a>

            <a
              href={`/organizations/${organization.id}/trace`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/organizations/${organization.id}/trace`);
              }}
            >
              Traceability
            </a>

            <a
              href={`/organizations/${organization.id}/aggregates`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/organizations/${organization.id}/aggregates`);
              }}
            >
              Aggregation
            </a>
          </nav>

          {parts[2] === 'trace' ? (
            <TraceWorkspace
              key={path}
              organizationId={organization.id}
              scope={parts[3]}
              referenceId={parts[4]}
            />
          ) : parts[2] === 'aggregates' ? (
            <AggregationWorkspace
              organizationId={organization.id}
              aggregateId={parts[3]}
              role={role}
              navigate={navigate}
            />
          ) : parts[2] === 'serials' ||
            (parts[2] === 'batches' && parts[4] === 'serials') ? (
            <SerialWorkspace
              key={organization.id}
              organizationId={organization.id}
              role={role}
              serialId={parts[2] === 'serials' ? parts[3] : undefined}
              batchId={parts[2] === 'batches' ? parts[3] : undefined}
              navigate={navigate}
            />
          ) : parts[2] === 'batches' ? (
            <BatchWorkspace
              key={organization.id}
              organizationId={organization.id}
              canWrite={!!role && canWriteOrganizationResource(role, 'batch')}
              batchId={parts[3]}
              navigate={navigate}
            />
          ) : parts[2] === 'products' ? (
            <ProductWorkspace
              key={organization.id}
              organizationId={organization.id}
              admin={admin}
              canWriteBatches={
                !!role && canWriteOrganizationResource(role, 'batch')
              }
              path={path}
              navigate={navigate}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">
                    {facility ? 'FACILITY DETAILS' : 'ORGANIZATION DETAILS'}
                  </p>
                  <h1>{facility?.name ?? organization.legalName}</h1>
                  <span className="status-pill">
                    {label(facility?.status ?? organization.status)}
                  </span>{' '}
                  <span className="role-badge">{role && label(role)}</span>
                </div>
                {admin && (
                  <button
                    className="secondary"
                    onClick={() => {
                      if (facility) {
                        facilityForm.reset({
                          name: facility.name,
                          type: facility.type,
                          gln: facility.gln ?? '',
                        });
                        setEditingFacility(true);
                      } else {
                        orgForm.reset({ legalName: organization.legalName });
                        setEditingOrg(true);
                      }
                    }}
                  >
                    Edit {facility ? 'facility' : 'organization'}
                  </button>
                )}
              </div>
              {editingOrg && orgEditor}
              {editingFacility && facilityEditor}
              {facility ? (
                <section className="welcome-panel">
                  <h2>Facility profile</h2>
                  <dl>
                    <div>
                      <dt>Type</dt>
                      <dd className="capitalize">{label(facility.type)}</dd>
                    </div>
                    <div>
                      <dt>GLN</dt>
                      <dd>{facility.gln ?? 'Not assigned'}</dd>
                    </div>
                    <div>
                      <dt>Organization</dt>
                      <dd>{organization.legalName}</dd>
                    </div>
                  </dl>
                  <p className="input-help">Facility ID: {facility.id}</p>
                </section>
              ) : (
                <>
                  <section className="welcome-panel">
                    <div className="section-heading">
                      <h2>
                        Facilities{' '}
                        <span className="count">{facilities.length}</span>
                      </h2>
                      {admin && (
                        <button
                          className="secondary"
                          onClick={() => {
                            facilityForm.reset({
                              name: '',
                              type: 'MANUFACTURER',
                              gln: '',
                            });
                            setCreatingFacility(true);
                          }}
                        >
                          Add facility
                        </button>
                      )}
                    </div>
                    {creatingFacility && facilityEditor}
                    {facilities.length ? (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Facility</th>
                              <th>Type</th>
                              <th>GLN</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {facilities.map((row) => (
                              <tr key={row.id}>
                                <td>
                                  <a
                                    href={`/organizations/${organization.id}/facilities/${row.id}`}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      navigate(
                                        `/organizations/${organization.id}/facilities/${row.id}`,
                                      );
                                    }}
                                  >
                                    {row.name}
                                  </a>
                                </td>
                                <td className="capitalize">
                                  {label(row.type)}
                                </td>
                                <td>{row.gln ?? '—'}</td>
                                <td className="capitalize">
                                  {label(row.status)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="muted">
                        No facilities yet.
                        {admin
                          ? ' Add your first facility to get started.'
                          : ''}
                      </p>
                    )}
                  </section>
                  <section className="welcome-panel">
                    <h2>
                      Memberships{' '}
                      <span className="count">{memberships.length}</span>
                    </h2>
                    <p className="muted">
                      Organization-scoped access. User identities remain owned
                      by Auth.
                    </p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Member ID</th>
                            <th>Role</th>
                          </tr>
                        </thead>
                        <tbody>
                          {memberships.map((member) => (
                            <tr key={member.id}>
                              <td className="member-id">
                                {member.userId}
                                {member.userId === userId && (
                                  <span className="role-badge">You</span>
                                )}
                              </td>
                              <td className="capitalize">
                                {label(member.role)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </>
              )}
            </>
          )}
        </>
      ) : null}
    </main>
  );
}
