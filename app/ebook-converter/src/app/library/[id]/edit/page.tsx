// src/app/library/[id]/edit/page.tsx
import { EpubEditor } from '@/components/library/EpubEditor';
import { getBook } from '@/lib/db/books';
import { notFound } from 'next/navigation';

export async function generateMetadata({ params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  return { title: book ? `Editing: ${book.title}` : 'EPUB editor' };
}

export default async function EditPage({ params }: { params: { id: string } }) {
  const book = await getBook(params.id);
  if (!book) notFound();
  return <EpubEditor bookId={book.id} />;
}
