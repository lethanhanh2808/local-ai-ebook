// src/app/library/[id]/read/page.tsx
// Full-screen EPUB reader page
import { EbookReader } from '@/components/library/EbookReader';
import { getBook } from '@/lib/db/books';
import { notFound } from 'next/navigation';

export async function generateMetadata({ params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  return { title: book ? `Reading: ${book.title}` : 'Reader' };
}

export default async function ReadPage({ params }: { params: { id: string } }) {
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
