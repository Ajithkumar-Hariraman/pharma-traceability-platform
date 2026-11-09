import type { Metadata } from 'next';
import { SessionProvider } from '../SessionProvider';
import '../styles.css';
export const metadata: Metadata = {
  title: { default: 'Pharma | Traceability', template: '%s | Pharma' },
  description:
    'Connected pharmaceutical operations and serialized pack verification.',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
