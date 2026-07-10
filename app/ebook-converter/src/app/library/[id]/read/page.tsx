// src/app/library/[id]/read/page.tsx
// Full-screen EPUB reader page
import { EbookReader } from '@/components/library/EbookReader';
import { getBook } from '@/lib/db/books';
import { notFound } from 'next/navigation';

export async function generateMetadata(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  return { title: book ? `Reading: ${book.title}` : 'Reader' };
}

export default async function ReadPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  if (!book) notFound();

  return (
    <EbookReader
      bookId={book.id}
      bookTitle={book.title}
      initialProgress={book.readProgress ?? 0}
    />
  );
}
