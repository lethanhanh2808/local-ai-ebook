// src/lib/queue/index.ts
// BullMQ queue and connection helpers
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

export interface ConversionJobData {
  jobId: string;
  inputPath: string;
  originalExt: string;
  filename: string;
  aiEnhance?: boolean;
  aiWatermarkClean?: boolean;
  /** Slow-but-thorough Vietnamese-novel formatter (paragraphs, dialogue, scene breaks). */
  deepFormat?: boolean;
  /** Strip heavy CSS + use minimal stylesheet so the output renders on
   *  Onyx Boox / Kobo Aura / older Kindle (devices whose renderers bail on
   *  animations, blur, text-shadow, fixed-position decorative pseudos). */
  readerFriendly?: boolean;
  aiPrompt?: string;
  /** True when the input needs an external-tool pre-step (e.g. MOBI → EPUB
   *  via Calibre) before the regular conversion pipeline can run. Phase 4.3
   *  of docs/NEXT_UP_PLAN.md. */
  requiresPreprocessing?: boolean;
}

export interface AudiobookChapterJobData {
  bookId: string;
  chapterFile: string;
  backend?: 'vieneu';
  force?: boolean;
}

export interface AudiobookBookJobData {
  bookId: string;
  backend?: 'vieneu';
}

export type AudiobookJobData = AudiobookChapterJobData | AudiobookBookJobData;

export const AUDIOBOOK_QUEUE_NAME = 'ebook-audiobook';

// ── Character Bible queue ──────────────────────────────────────────────────
// Background jobs that ask an LLM to refresh a book's Character Bible
// after a chapter closes. One job per (bookId, chapterIndex) — the worker
// dedupes by jobId so duplicate enqueues collapse into a single invocation.
export const CHARACTER_BIBLE_QUEUE_NAME = 'ebook-character-bible';

export interface CharacterBibleJobData {
  bookId: string;
  chapterIndex: number;
  chapterFile?: string | null;
  /** When true, auto-merge non-conflicting LLM patches. When false, all
   *  patches land in PendingBibleDiff for user review. */
  autoMerge?: boolean;
  /** Why the job was enqueued. */
  reason?: 'chapter-close' | 'book-load' | 'manual';
}

const redisConnection = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // required by BullMQ
};

export const QUEUE_NAME = 'ebook-conversion';

// Lazily created so the Next.js API process can import without starting Redis
let _queue: Queue<ConversionJobData> | null = null;
let _events: QueueEvents | null = null;

export function getQueue(): Queue<ConversionJobData> {
  if (!_queue) {
    _queue = new Queue<ConversionJobData>(QUEUE_NAME, {
      connection: new IORedis(redisConnection),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return _queue;
}

export function getQueueEvents(): QueueEvents {
  if (!_events) {
    _events = new QueueEvents(QUEUE_NAME, {
      connection: new IORedis(redisConnection),
    });
  }
  return _events;
}

// ── Audiobook queue ─────────────────────────────────────────────────────────
let _audiobookQueue: Queue<AudiobookJobData> | null = null;

export function getAudiobookQueue(): Queue<AudiobookJobData> {
  if (!_audiobookQueue) {
    _audiobookQueue = new Queue<AudiobookJobData>(AUDIOBOOK_QUEUE_NAME, {
      connection: new IORedis(redisConnection),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
  }
  return _audiobookQueue;
}

let _characterBibleQueue: Queue<CharacterBibleJobData> | null = null;

export function getCharacterBibleQueue(): Queue<CharacterBibleJobData> {
  if (!_characterBibleQueue) {
    _characterBibleQueue = new Queue<CharacterBibleJobData>(CHARACTER_BIBLE_QUEUE_NAME, {
      connection: new IORedis(redisConnection),
      defaultJobOptions: {
        attempts: 1, // LLM-driven jobs are expensive; retry manually instead
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return _characterBibleQueue;
}

export { redisConnection };
