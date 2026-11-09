import { ProtectedShell } from '../../ProtectedShell';
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ProtectedShell>{children}</ProtectedShell>;
}
