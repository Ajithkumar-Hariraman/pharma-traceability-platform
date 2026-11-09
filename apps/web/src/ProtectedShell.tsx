'use client';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from './SessionProvider';
import { logout } from './auth';
import { ErrorState, LoadingState } from './ui';
export function ProtectedShell({ children }: { children: React.ReactNode }) {
  const { user, loading, error, retry, setUser } = useSession();
  const router = useRouter();
  const path = usePathname();
  const params = useParams<{ organizationId?: string }>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (!loading && !error && !user) router.replace('/login');
  }, [loading, error, user, router]);
  useEffect(() => setOpen(false), [path]);
  if (loading) return <LoadingState message="Verifying your session…" />;
  if (error) return <ErrorState message={error} retry={retry} />;
  if (!user) return <LoadingState message="Returning to sign in…" />;
  const base = params.organizationId
    ? `/organizations/${params.organizationId}`
    : '';
  const nav = [
    ['Overview', ''],
    ['Facilities', '/facilities'],
    ['Products', '/products'],
    ['Batches', '/batches'],
    ['Serialization', '/serials'],
    ['Aggregation', '/aggregates'],
    ['Shipments', '/shipments'],
    ['Traceability', '/trace'],
    ['Recalls', '/recalls'],
    ['Verification', '/verification'],
  ];
  return (
    <div className="workspace">
      <a className="skip-link" href="#workspace-content">
        Skip to content
      </a>
      <aside
        className={open ? 'sidebar is-open' : 'sidebar'}
        id="workspace-navigation"
      >
        <Link className="brand" href="/organizations">
          <span className="mark">P</span>
          <span>
            Pharma<span className="brand-sub">TRACEABILITY PLATFORM</span>
          </span>
        </Link>
        <nav aria-label="Workspace">
          <p className="nav-label">WORKSPACE</p>
          <Link
            className="nav-item"
            href="/organizations"
            aria-current={path === '/organizations' ? 'page' : undefined}
          >
            Organizations
          </Link>
          {base && (
            <>
              <p className="nav-label">ORGANIZATION</p>
              {nav.map(([title, suffix]) => (
                <Link
                  key={title}
                  className="nav-item"
                  href={base + suffix}
                  aria-current={
                    (suffix ? path.startsWith(base + suffix) : path === base)
                      ? 'page'
                      : undefined
                  }
                >
                  {title}
                </Link>
              ))}
            </>
          )}
        </nav>
        <div className="aside-foot">
          Connected care.
          <br />
          Trusted supply.
        </div>
      </aside>
      <div className="workspace-body">
        <header>
          <button
            className="secondary mobile-menu"
            aria-expanded={open}
            aria-controls="workspace-navigation"
            onClick={() => setOpen((v) => !v)}
          >
            Menu
          </button>
          <span>{base ? 'Organization operations' : 'Workspace'}</span>
          <div className="account">
            <span>{user.email}</span>
            <button
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFailure('');
                try {
                  await logout();
                  setUser(null);
                  router.replace('/login');
                } catch {
                  setFailure('Unable to sign out. Please retry.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </header>
        {failure && (
          <p className="alert error" role="alert">
            {failure}
          </p>
        )}
        <div id="workspace-content" tabIndex={-1}>
          {children}
        </div>
      </div>
    </div>
  );
}
