'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { currentUser, refreshSession, type User } from './auth';
const SessionContext = createContext<{
  user: User | null;
  loading: boolean;
  error: string;
  retry: () => void;
  setUser: (user: User | null) => void;
}>({
  user: null,
  loading: true,
  error: '',
  retry: () => {},
  setUser: () => {},
});
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void refreshSession()
      .then(currentUser)
      .then((value) => {
        if (active) setUser(value);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (
          failure instanceof Error &&
          'status' in failure &&
          failure.status === 401
        )
          setUser(null);
        else setError('Session service unavailable. Please retry.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);
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
          )
            setUser(null);
        });
    }, 60000);
    const expired = () => setUser(null);
    window.addEventListener('pharma:session-expired', expired);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pharma:session-expired', expired);
    };
  }, [user]);
  return (
    <SessionContext.Provider
      value={{
        user,
        loading,
        error,
        retry: () => setRevision((v) => v + 1),
        setUser,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export const useSession = () => useContext(SessionContext);
