// src/app/library/[id]/assign-voices/page.tsx
// Legacy route — redirect to the new Audio Studio (Phân giọng tab).
import { redirect } from 'next/navigation';

export default async function AssignVoicesRedirect(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  redirect(`/library/${params.id}/audio?tab=assign`);
}
