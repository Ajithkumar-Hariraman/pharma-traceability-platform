import { notFound } from 'next/navigation';
import { WorkspacePage } from '../../../../../../WorkspacePage';
export default async function Page({
  params,
}: {
  params: Promise<{ scope: string }>;
}) {
  const { scope } = await params;
  if (!['serials', 'batches', 'aggregates'].includes(scope)) notFound();
  return <WorkspacePage section="trace" />;
}
