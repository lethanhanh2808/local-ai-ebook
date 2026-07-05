// src/lib/db/jobs.ts
// CRUD helpers for the Job model
import { prisma } from './client';

export type JobStatus = 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type JobStage = 'upload' | 'validate' | 'repair' | 'convert' | 'embed' | 'done';

export interface CreateJobInput {
  id: string;
  filename: string;
  originalExt: string;
  inputPath: string;
  status?: JobStatus;
  /** Path to the per-job NDJSON log file. Setting this at creation time
   *  enables the Debug Console button immediately, even before the worker
   *  picks the job up. */
  logPath?: string;
}

export async function createJob(input: CreateJobInput) {
  return prisma.job.create({
    data: { ...input, status: input.status ?? 'queued' },
  });
}

export async function updateJob(
  id: string,
  data: {
    status?: JobStatus;
    progress?: number;
    stage?: JobStage;
    outputPath?: string;
    errorMsg?: string;
    metadata?: Record<string, unknown>;
    report?: Record<string, unknown>;
    /** Top-level scalar fields that can be set directly. */
    aiModel?: string;
    aiProvider?: string;
    aiTotalTokens?: number;
    aiTotalDurationMs?: number;
    aiCallCount?: number;
    aiGenerationTokensPerSecond?: number | null;
    aiPromptTokensPerSecond?: number | null;
    logPath?: string;
  },
) {
  const { metadata, report, ...rest } = data;
  return prisma.job.update({
    where: { id },
    data: {
      ...rest,
      ...(metadata !== undefined ? { metadata: JSON.stringify(metadata) } : {}),
      ...(report !== undefined ? { report: JSON.stringify(report) } : {}),
    },
  });
}

export async function getJob(id: string) {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return null;
  return hydrateJob(job);
}

export async function listJobs(limit = 50) {
  const jobs = await prisma.job.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return jobs.map(hydrateJob);
}

export async function deleteJob(id: string) {
  return prisma.job.delete({ where: { id } });
}

/** Find pending jobs for a list of IDs. Used by "Start all". */
export async function listPendingJobs(ids?: string[]) {
  const where = ids && ids.length > 0
    ? { id: { in: ids }, status: 'pending' }
    : { status: 'pending' };
  return prisma.job.findMany({ where, orderBy: { createdAt: 'asc' } });
}

function hydrateJob(job: {
  id: string;
  filename: string;
  originalExt: string;
  status: string;
  progress: number;
  stage: string;
  inputPath: string;
  outputPath: string | null;
  errorMsg: string | null;
  metadata: string | null;
  report: string | null;
  createdAt: Date;
  updatedAt: Date;
  aiProvider?: string | null;
  aiModel?: string | null;
  aiTotalTokens?: number | null;
  aiTotalDurationMs?: number | null;
  aiCallCount?: number | null;
  aiGenerationTokensPerSecond?: number | null;
  aiPromptTokensPerSecond?: number | null;
  logPath?: string | null;
}) {
  return {
    ...job,
    metadata: job.metadata ? (JSON.parse(job.metadata) as Record<string, unknown>) : null,
    report: job.report ? (JSON.parse(job.report) as Record<string, unknown>) : null,
  };
}
