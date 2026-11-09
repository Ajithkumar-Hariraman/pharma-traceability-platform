'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Organization } from '@pharma/contracts';
import { useSession } from './SessionProvider';
import { authenticatedRequest } from './auth';
import { VerificationWorkspace } from './VerificationWorkspace';
export function PublicVerification() {
  const { user, loading, error: sessionError, retry } = useSession();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (user)
      void authenticatedRequest<Organization[]>('/organizations')
        .then((rows) => {
          if (active) {
            setOrganizations(rows);
            setOrganizationId(rows[0]?.id ?? '');
          }
        })
        .catch(() => {
          if (active)
            setError(
              'Unable to load organizations. Return to your workspace and retry.',
            );
        });
    return () => {
      active = false;
    };
  }, [user]);
  if (loading) return <p role="status">Checking session…</p>;
  if (sessionError)
    return (
      <p role="alert">
        {sessionError} <button onClick={retry}>Retry</button>
      </p>
    );
  if (!user)
    return (
      <section className="verification-result">
        <h2>Sign in to verify a pack</h2>
        <p>
          Verification currently requires authorized organization access. Public
          verification is planned; no pack information is disclosed without
          authentication.
        </p>
        <Link className="primary" href="/login">
          Sign in
        </Link>
        <p>Use the GTIN and serial number printed on the pack.</p>
      </section>
    );
  return (
    <>
      <label htmlFor="verification-organization">Organization</label>
      <select
        id="verification-organization"
        value={organizationId}
        onChange={(e) => setOrganizationId(e.target.value)}
      >
        <option value="">Choose an organization</option>
        {organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.legalName}
          </option>
        ))}
      </select>
      {error && <p role="alert">{error}</p>}
      {organizationId && (
        <VerificationWorkspace
          key={organizationId}
          organizationId={organizationId}
        />
      )}
      <Link href="/organizations">Return to workspace</Link>
    </>
  );
}
