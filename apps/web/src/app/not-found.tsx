import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="dashboard">
      <h1>Page not found</h1>
      <p>Check the address or return to your organizations.</p>
      <Link href="/organizations">Organizations</Link>
    </main>
  );
}
