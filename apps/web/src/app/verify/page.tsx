import Link from 'next/link';
import type { Metadata } from 'next';
import { PublicVerification } from '../../PublicVerification';
export const metadata: Metadata = {
  title: 'Verify a pharmaceutical pack',
  description:
    'Check a serialized pharmaceutical pack using its GS1 GTIN and serial number. Authorized organization access is currently required.',
};
export default function Page() {
  return (
    <main className="dashboard public-verify">
      <Link className="brand" href="/organizations">
        <span className="mark">P</span>Pharma
      </Link>
      <p className="eyebrow">CONFIDENCE AT EVERY STEP</p>
      <h1>Verify a pharmaceutical pack</h1>
      <p className="muted">A clear status. A safer next step.</p>
      <PublicVerification />
    </main>
  );
}
