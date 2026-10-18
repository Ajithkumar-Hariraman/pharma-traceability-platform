import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  credentialsSchema,
  currentUser,
  login,
  logout,
  refreshSession,
  register,
  type Credentials,
  type User,
} from './auth';
import './styles.css';
import { OrganizationWorkspace } from './OrganizationWorkspace';
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(
    window.location.pathname === '/register' ? 'register' : 'login',
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '' },
  });
  function navigate(next: string) {
    window.history.replaceState({}, '', `/${next}`);
    setPage(next);
  }
  useEffect(() => {
    void refreshSession()
      .then(currentUser)
      .then((value) => {
        setUser(value);
        if (!window.location.pathname.startsWith('/organizations'))
          window.history.replaceState({}, '', '/dashboard');
      })
      .catch((failure: unknown) => {
        if (
          failure instanceof Error &&
          'status' in failure &&
          failure.status !== 401
        )
          setError(failure.message);
        if (window.location.pathname !== '/register') {
          window.history.replaceState({}, '', '/login');
          setPage('login');
        }
      })
      .finally(() => setLoading(false));
    const onPop = () =>
      setPage(window.location.pathname === '/register' ? 'register' : 'login');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // Revalidate periodically so expired access tokens refresh without persisting tokens in storage.
  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      void currentUser()
        .then(setUser)
        .catch((failure: unknown) => {
          if (
            failure instanceof Error &&
            'status' in failure &&
            failure.status === 401
          ) {
            setUser(null);
            navigate('login');
            setError('Your session has expired. Please sign in again');
          }
        });
    }, 60000);
    return () => window.clearInterval(timer);
  }, [user]);
  const submit = form.handleSubmit(async (values) => {
    setError('');
    setNotice('');
    try {
      if (page === 'register') {
        await register(values);
        form.reset({ email: values.email, password: '' });
        navigate('login');
        setNotice('Account created. Sign in to your workspace.');
      } else {
        setUser(await login(values));
        form.reset();
        navigate('dashboard');
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to connect. Please try again',
      );
    }
  });
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await logout();
      setUser(null);
      navigate('login');
      setNotice('You have been signed out.');
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to sign out. Please try again',
      );
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <main className="loading" role="status">
        <span className="mark">P</span>
        <p>Verifying your session…</p>
      </main>
    );
  if (user)
    return (
      <div className="workspace">
        <aside>
          <a className="brand" href="/dashboard">
            <span className="mark">P</span>
            <span>
              Pharma<span className="brand-sub">TRACEABILITY PLATFORM</span>
            </span>
          </a>
          <p className="nav-label">WORKSPACE</p>
          <a className="nav-item" href="/organizations" aria-current="page">
            Organizations
          </a>
          <div className="aside-foot">
            Connected care.
            <br />
            Trusted supply.
          </div>
        </aside>
        <div className="workspace-body">
          <header>
            <span>Organization workspace</span>
            <div className="account">
              <span>{user.email}</span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void signOut()}
              >
                {busy ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </header>
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          <OrganizationWorkspace userId={user.id} />
        </div>
      </div>
    );
  return (
    <main className="auth-layout">
      <section className="intro">
        <a className="brand" href="/login">
          <span className="mark">P</span>
          <span>
            Pharma<span className="brand-sub">TRACEABILITY PLATFORM</span>
          </span>
        </a>
        <div>
          <p className="eyebrow">CONFIDENCE AT EVERY STEP</p>
          <h1>
            Trusted access.
            <br />
            Connected supply.
          </h1>
          <p>
            A secure workspace for the people behind pharmaceutical
            traceability.
          </p>
          <div className="intro-detail">
            <span>01</span>
            <p>One account. A connected foundation.</p>
          </div>
          <div className="intro-detail">
            <span>02</span>
            <p>Secure sessions. Clear visibility.</p>
          </div>
        </div>
        <small>Built for pharmaceutical operations.</small>
      </section>
      <section className="form-area">
        <div className="form-card">
          <p className="eyebrow">
            {page === 'register' ? 'GET STARTED' : 'WELCOME BACK'}
          </p>
          <h2>
            {page === 'register'
              ? 'Create your account'
              : 'Sign in to your workspace'}
          </h2>
          <p className="muted">
            {page === 'register'
              ? 'Set up secure access to Pharma.'
              : 'Enter your credentials to continue.'}
          </p>
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="alert success" role="status">
              {notice}
            </p>
          )}
          <form onSubmit={(event) => void submit(event)} noValidate>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              aria-invalid={!!form.formState.errors.email}
              aria-describedby="email-error"
              {...form.register('email')}
            />
            <p id="email-error" className="field-error">
              {form.formState.errors.email?.message}
            </p>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={
                page === 'register' ? 'new-password' : 'current-password'
              }
              aria-invalid={!!form.formState.errors.password}
              aria-describedby="password-help password-error"
              {...form.register('password')}
            />
            <p id="password-help" className="input-help">
              Use 12–128 characters.
            </p>
            <p id="password-error" className="field-error">
              {form.formState.errors.password?.message}
            </p>
            <button
              className="primary"
              type="submit"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting
                ? 'Please wait…'
                : page === 'register'
                  ? 'Create account'
                  : 'Sign in'}
            </button>
          </form>
          <p className="switch">
            {page === 'register'
              ? 'Already have an account?'
              : 'New to Pharma?'}{' '}
            <a
              href={page === 'register' ? '/login' : '/register'}
              onClick={(event) => {
                event.preventDefault();
                setError('');
                setNotice('');
                form.reset();
                navigate(page === 'register' ? 'login' : 'register');
              }}
            >
              {page === 'register' ? 'Sign in' : 'Create an account'}
            </a>
          </p>
          <p className="security-note">Secure access · Protected sessions</p>
        </div>
      </section>
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');
createRoot(root).render(<App />);
