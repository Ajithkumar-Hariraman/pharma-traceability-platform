'use client';
import { usePathname } from 'next/navigation';
import { useSession } from './SessionProvider';
import { OrganizationWorkspace } from './OrganizationWorkspace';
export function WorkspacePage({ section }: { section?: string }) {
  const { user } = useSession();
  const path = usePathname();
  return user ? (
    <OrganizationWorkspace key={path} section={section} userId={user.id} />
  ) : null;
}
