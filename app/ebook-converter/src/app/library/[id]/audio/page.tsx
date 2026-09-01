// src/app/library/[id]/audio/page.tsx
// Dedicated full-page "Audio Studio" for a book.
import { AudioStudio } from '@/components/library/AudioStudio';
import { getBook } from '@/lib/db/books';
import { notFound } from 'next/navigation';

export async function generateMetadata(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  return { title: book ? `Audio Studio: ${book.title}` : 'Audio Studio' };
}

export default async function AudioStudioPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) notFound();

  return (
    <AudioStudio
      bookId={book.id}
      bookTitle={book.title}
    />
  );
}
