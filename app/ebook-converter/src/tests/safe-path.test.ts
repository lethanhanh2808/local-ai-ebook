import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertWithinRoots, SafePathError } from '@/lib/storage/safe-path';

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-safe-path-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('assertWithinRoots', () => {
  it('accepts existing and not-yet-created files below an allowed root', () => {
    const root = makeRoot();
    const existing = path.join(root, 'book.epub');
    fs.writeFileSync(existing, 'epub');

    expect(assertWithinRoots(existing, [root])).toBe(fs.realpathSync.native(existing));
    expect(assertWithinRoots(path.join(root, 'future', 'chapter.wav'), [root]))
      .toBe(path.join(fs.realpathSync.native(root), 'future', 'chapter.wav'));
  });

  it('rejects traversal and sibling-prefix paths', () => {
    const parent = makeRoot();
    const root = path.join(parent, 'library');
    const sibling = path.join(parent, 'library-backup', 'book.epub');
    fs.mkdirSync(root);

    expect(() => assertWithinRoots(path.join(root, '..', 'secret'), [root]))
      .toThrow(SafePathError);
    expect(() => assertWithinRoots(sibling, [root])).toThrow(SafePathError);
  });

  it('rejects a symlink that escapes an allowed root', () => {
    const parent = makeRoot();
    const root = path.join(parent, 'library');
    const outside = path.join(parent, 'private');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'linked'));

    expect(() => assertWithinRoots(path.join(root, 'linked', 'secret.txt'), [root]))
      .toThrow(SafePathError);
    expect(() => assertWithinRoots(path.join(root, 'linked', 'future.txt'), [root]))
      .toThrow(SafePathError);
  });

  it('rejects empty paths', () => {
    expect(() => assertWithinRoots('', [makeRoot()])).toThrow(SafePathError);
  });
});
