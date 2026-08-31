// src/app/library/[id]/assign-voices/page.tsx
// Dedicated full-page "Phân giọng" (voice assignment) experience.
import { VoiceAssignPage } from '@/components/library/VoiceAssignPage';
import { getBook } from '@/lib/db/books';
import { notFound } from 'next/navigation';

export async function generateMetadata(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  return { title: book ? `Phân giọng: ${book.title}` : 'Phân giọng' };
}

export default async function AssignVoicesPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) notFound();

  return (
    <VoiceAssignPage
      bookId={book.id}
      bookTitle={book.title}
    />
  );
}
