'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { credentialsSchema, login, register, type Credentials } from './auth';
import { useSession } from './SessionProvider';
export function AuthPage({ page }: { page: 'login' | 'register' }) {
  const router = useRouter();
  const { user, loading, error: sessionError, retry, setUser } = useSession();
  useEffect(() => {
    if (user) router.replace('/organizations');
  }, [user, router]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const form = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '' },
  });
  function navigate(next: string) {
    router.push('/' + next);
  }
  const submit = form.handleSubmit(async (values) => {
    setError('');
    setNotice('');
    try {
      if (page === 'register') {
        await register(values);
        form.reset();
        setNotice('Account created. Sign in to your workspace.');
        navigate('login');
      } else {
        setUser(await login(values));
        form.reset();
        navigate('organizations');
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to sign in. Please retry.',
      );
    }
  });
  if (loading)
    return (
      <main className="loading" role="status">
        Checking session…
      </main>
    );
  if (sessionError)
    return (
      <main className="dashboard">
        <p role="alert">{sessionError}</p>
        <button onClick={retry}>Retry</button>
      </main>
    );
  return (
    <main className="auth-layout">
      <section className="intro">
        <Link className="brand" href="/login">
          <span className="mark">P</span>
          <span>
            Pharma<span className="brand-sub">TRACEABILITY PLATFORM</span>
          </span>
        </Link>
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
            <Link
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
            </Link>
          </p>
          <p className="security-note">Secure access · Protected sessions</p>
        </div>
      </section>
    </main>
  );
}
