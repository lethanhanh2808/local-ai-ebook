// src/lib/queue/index.ts
// BullMQ queue and connection helpers
import { Queue, Worker, QueueEvents } from 'bullmq';
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
  aiPrompt?: string;
}

export interface AudiobookChapterJobData {
  bookId: string;
  chapterFile: string;
  backend?: 'piper' | 'moss-nano' | 'vieneu';
  force?: boolean;
}

export interface AudiobookBookJobData {
  bookId: string;
  backend?: 'piper' | 'moss-nano' | 'vieneu';
}

export type AudiobookJobData = AudiobookChapterJobData | AudiobookBookJobData;

export const AUDIOBOOK_QUEUE_NAME = 'ebook-audiobook';

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

export { redisConnection };
