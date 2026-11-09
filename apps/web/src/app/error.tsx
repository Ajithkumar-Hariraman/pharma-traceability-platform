'use client';
import { ErrorState } from '../ui';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="dashboard">
      <ErrorState
        message="This page could not be loaded. Please try again."
        retry={reset}
      />
    </main>
  );
}
