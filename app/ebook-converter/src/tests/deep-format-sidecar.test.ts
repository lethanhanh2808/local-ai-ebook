// src/tests/deep-format-sidecar.test.ts
//
// Unit tests for the deep-format sidecar module — the file that lets the
// character-bible worker read the AI-cleaned chapter text instead of
// re-parsing the source EPUB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  writeDeepFormatSidecar,
  readDeepFormatSidecar,
  restampDeepFormatSidecar,
  sidecarPathFor,
  type SidecarChapter,
} from '../lib/pipeline/deep-format-sidecar';

describe('deep-format-sidecar', () => {
  let tmpDir: string;
  let epubPath: string;
  let bookId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-test-'));
    bookId = 'test-book-uuid-' + Date.now();
    epubPath = path.join(tmpDir, `${bookId}.epub`);
    await fs.writeFile(epubPath, 'fake epub bytes', 'utf8');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('computes the sidecar path next to the EPUB', () => {
    expect(sidecarPathFor('/foo/bar.epub')).toBe('/foo/bar.epub.deepFormat.json');
    expect(sidecarPathFor('/with spaces/x.epub')).toBe('/with spaces/x.epub.deepFormat.json');
  });

  it('roundtrips a written sidecar', async () => {
    const chapters: SidecarChapter[] = [
      { index: 0, title: 'Chương 1', text: 'Nội dung chương 1...' },
      { index: 1, title: 'Chương 2', text: 'Nội dung chương 2...' },
    ];
    const written = await writeDeepFormatSidecar({
      outputPath: epubPath,
      bookId,
      chapters,
      aiCalls: 2,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return; // narrow for TS
    expect(written.bytes).toBeGreaterThan(50);
    expect(written.path).toBe(`${epubPath}.deepFormat.json`);

    const read = await readDeepFormatSidecar({ epubPath, bookId: 'any-id-is-fine' });
    expect(read).not.toBeNull();
    expect(read!.version).toBe(1);
    expect(read!.chapters).toHaveLength(2);
    expect(read!.chapters[0].title).toBe('Chương 1');
    expect(read!.chapters[1].text).toContain('chương 2');
  });

  it('returns null when the sidecar file does not exist', async () => {
    const otherPath = path.join(tmpDir, 'never-written.epub');
    const read = await readDeepFormatSidecar({ epubPath: otherPath, bookId: 'x' });
    expect(read).toBeNull();
  });

  it('returns null for a malformed sidecar', async () => {
    const badPath = path.join(tmpDir, 'bad.epub');
    await fs.writeFile(badPath, 'fake', 'utf8');
    await fs.writeFile(`${badPath}.deepFormat.json`, '{not valid json', 'utf8');
    const read = await readDeepFormatSidecar({ epubPath: badPath, bookId: 'x' });
    expect(read).toBeNull();
  });

  it('re-stamps the bookId field', async () => {
    const newBookId = 'imported-book-uuid-' + Date.now();
    const r = await restampDeepFormatSidecar({ epubPath, newBookId });
    expect(r.ok).toBe(true);
    const read = await readDeepFormatSidecar({ epubPath, bookId: newBookId });
    expect(read).not.toBeNull();
    expect(read!.bookId).toBe(newBookId);
    // Old bookId should no longer be present in the file.
    const raw = await fs.readFile(`${epubPath}.deepFormat.json`, 'utf8');
    expect(raw).not.toContain(bookId);
  });

  it('re-stamp is a no-op when the bookId already matches', async () => {
    const same = 'already-stamped-id';
    await writeDeepFormatSidecar({
      outputPath: path.join(tmpDir, 'noop.epub'),
      bookId: same,
      chapters: [{ index: 0, title: 'X', text: 'y' }],
    });
    const r = await restampDeepFormatSidecar({
      epubPath: path.join(tmpDir, 'noop.epub'),
      newBookId: same,
    });
    expect(r.ok).toBe(true);
  });
});
