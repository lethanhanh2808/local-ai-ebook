// src/app/library/[id]/edit/page.tsx
import { EpubEditor } from '@/components/library/EpubEditor';
import { getBook } from '@/lib/db/books';
import { notFound } from 'next/navigation';

// Chapter ID can be deep-linked from the reader via ?chapter=<id> so a
// typo spotted while reading jumps straight to the right chapter. The
// editor itself still has the chapter sidebar for navigation; the query
// param just chooses the initial selection.
export default async function EditPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.params;
  const sp = await props.searchParams;
  const book = await getBook(params.id);
  if (!book) notFound();
  const rawChapter = sp.chapter;
  const initialChapterId = typeof rawChapter === 'string' ? rawChapter : Array.isArray(rawChapter) ? rawChapter[0] : undefined;
  return <EpubEditor bookId={book.id} initialChapterId={initialChapterId} />;
}

export async function generateMetadata(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const book = await getBook(params.id);
  return { title: book ? `Editing: ${book.title}` : 'EPUB editor' };
}

