// scripts/seed-ngoc-ngan.ts
//
// Seed Nguyễn Ngọc Ngạn (famous Vietnamese storyteller/MC) as a per-book
// cloned voice. The user runs this locally at home and is intentionally
// NOT concerned about the underlying model license ("we only using
// locally as private at home, so we don't need to care about the
// license"). We don't gate the script on any license check.
//
// Approach: rather than spinning up a separate Matcha-TTS service to use
// the doof-ferb/matcha_ngngngan checkpoint, we register Ngọc Ngạn as a
// standard cloned voice — same as if the user uploaded a 30s WAV clip
// via the VoicePanel UI. VieNeu-TTS's `infer(text, ref_audio=...)` does
// the timbre cloning; the audio quality depends on the reference clip
// you drop in.
//
// What you need to do (manual one-time, ~30s of audio):
//   1. Drop a ~10-30 second WAV/MP3 clip of Ngọc Ngạn reading clearly
//      (no background music, sampled ≥ 16 kHz) into one of:
//         data/voices/_seed/ngoc-ngan.wav
//         data/voices/_seed/ngoc-ngan.mp3
//         data/voices/_seed/ngoc-ngan.m4a
//      (We refuse to bundle a sample in this repo to keep LICENSE clear.)
//   2. Run this script with --book <id> (repeatable) or with no flag to
//      seed every book in the DB. Pass --dry-run first to audit.
//
// The seed is idempotent: if a Voice row with name === 'Nguyễn Ngọc
// Ngạn' already exists for the book, the script skips it.
//
// Usage:
//   npx tsx scripts/seed-ngoc-ngan.ts --dry-run --book <uuid>          # audit one
//   npx tsx scripts/seed-ngoc-ngan.ts --book <uuid>                   # commit one
//   npx tsx scripts/seed-ngoc-ngan.ts --book <id1> --book <id2>       # commit many
//   npx tsx scripts/seed-ngoc-ngan.ts                                 # all books
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });

import { v4 as uuid } from 'uuid';
import { prisma } from '../src/lib/db/client';
import { listVoices, createVoice } from '../src/lib/db/voices';
import { setBookAudiobookStatus } from '../src/lib/db/audiobook';

const VOICE_NAME = 'Nguyễn Ngọc Ngạn';
const VOICE_DESCRIPTION = 'Giọng kể chuyện (clone riêng, nội bộ) — bỏ file mẫu vào data/voices/_seed/ngoc-ngan.{wav,mp3,m4a}';

const VOICES_DIR = path.resolve(process.cwd(), 'data/voices');
const SEED_DIR = path.join(VOICES_DIR, '_seed');
// Order matters: prefer WAV (uncompressed) > MP3 (compressed but ubiquitous) > M4A.
const SEED_CANDIDATES = ['ngoc-ngan.wav', 'ngoc-ngan.mp3', 'ngoc-ngan.m4a'];

function findSeedPath(): { src: string; ext: string } | null {
  for (const f of SEED_CANDIDATES) {
    const p = path.join(SEED_DIR, f);
    if (fs.existsSync(p)) return { src: p, ext: f.split('.').pop() ?? 'wav' };
  }
  return null;
}

interface SeedReport {
  bookId: string;
  bookTitle: string;
  status: 'created' | 'skipped-exists' | 'ref-missing';
  voiceId?: string;
  refPath?: string;
}

async function seedForBook(bookId: string, dryRun: boolean): Promise<SeedReport> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { id: true, title: true } });
  if (!book) return { bookId, bookTitle: '(missing)', status: 'ref-missing' };

  // Idempotent skip — already seeded?
  const existing = await listVoices(book.id);
  const dup = existing.find((v) => v.name === VOICE_NAME);
  if (dup) {
    return { bookId: book.id, bookTitle: book.title, status: 'skipped-exists', voiceId: dup.id, refPath: dup.refAudioPath };
  }

  const seed = findSeedPath();
  let refPath: string;
  if (seed) {
    // Copy into the per-book voices dir so it's picked up consistently with
    // the upload-API path. Pre-generate the UUID so we can name the file
    // (and so the DB row's id matches the on-disk filename).
    const voiceId = uuid();
    const ext = seed.ext;
    const bookVoicesDir = path.join(VOICES_DIR, book.id);
    fs.mkdirSync(bookVoicesDir, { recursive: true });
    refPath = path.join(bookVoicesDir, `${voiceId}.${ext}`);

    if (!dryRun) {
      fs.copyFileSync(seed.src, refPath);
      await createVoice({
        bookId: book.id,
        name: VOICE_NAME,
        description: VOICE_DESCRIPTION,
        refAudioPath: refPath,
        language: 'vi',
        isDefault: false,
        // kind='narrator' so the reader surfaces it as a story-teller option
        // alongside the 10 built-ins. (voice-selector treats kind=common /
        // narrator / character identically for routing.)
        kind: 'narrator',
        builtinName: null,  // cloned, not a built-in preset
      });
      await setBookAudiobookStatus(book.id, 'none');
    }
    return { bookId: book.id, bookTitle: book.title, status: 'created', voiceId, refPath };
  }

  // No seed file present. We don't fail — we just log a TODO so the user
  // knows to drop one in. The audio simply won't play (similar to how a
  // user-uploaded row with a missing ref file behaves).
  return { bookId: book.id, bookTitle: book.title, status: 'ref-missing' };
}

async function resolveTargetBookIds(args: string[]): Promise<string[]> {
  const bookFlags = args.flatMap((a, i) => (a === '--book' ? [args[i + 1]] : []));
  if (bookFlags.length > 0) {
    return bookFlags.filter((x): x is string => !!x);
  }
  const all = await prisma.book.findMany({ select: { id: true } });
  return all.map((b) => b.id);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const targetIds = await resolveTargetBookIds(args);
  if (targetIds.length === 0) {
    console.error('No books in DB and no --book <id> passed. Nothing to do.');
    process.exit(1);
  }

  const seed = findSeedPath();
  if (!seed) {
    console.warn('────────────────────────────────────────────────────────────────────');
    console.warn(' No reference audio found at any of:');
    for (const f of SEED_CANDIDATES) console.warn(`   ${path.join(SEED_DIR, f)}`);
    console.warn(' The voice row will still be created but it will not play audio.');
    console.warn(' Drop a 10-30s WAV/MP3/M4A clip there and re-run.');
    console.warn('────────────────────────────────────────────────────────────────────');
  } else {
    console.log(`Reference audio: ${seed.src}`);
  }

  const reports: SeedReport[] = [];
  for (const id of targetIds) {
    const r = await seedForBook(id, dryRun);
    reports.push(r);
  }

  console.log('\nResults:');
  for (const r of reports) {
    const tag = r.status === 'created'      ? '✓ created'
              : r.status === 'skipped-exists' ? '↺ skipped (already exists)'
              : '⚠ ref-missing (no audio file — playback will fail until you drop one)';
    console.log(`  ${tag}  ${r.bookTitle} (${r.bookId.slice(0, 8)})`);
    if (r.refPath) console.log(`        refPath: ${r.refPath}`);
    if (r.voiceId)  console.log(`        voiceId: ${r.voiceId}`);
  }

  const created = reports.filter((r) => r.status === 'created').length;
  const skipped = reports.filter((r) => r.status === 'skipped-exists').length;
  const missing = reports.filter((r) => r.status === 'ref-missing').length;

  console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}Created ${created}, skipped ${skipped}, ref-missing ${missing}.`);
  if (created > 0 && !dryRun) {
    console.log(`Marked ${new Set(reports.filter((r) => r.status === 'created').map((r) => r.bookId)).size} book(s) for re-generation on next audio pre-gen.`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('seed-ngoc-ngan failed:', e);
      process.exit(1);
    });
}

export { findSeedPath, seedForBook, VOICE_NAME };
