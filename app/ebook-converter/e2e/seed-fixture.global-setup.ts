// e2e/seed-fixture.global-setup.ts
//
// Phase 4.1 of `docs/NEXT_UP_PLAN.md` — seeds the E2E library with the
// committed `e2e/fixtures/minimal-novel.epub` so the smoke + GUI specs
// don't need to depend on a real book the user happened to upload.
//
// Wired in `playwright.config.ts` as `globalSetup`; runs ONCE per
// `playwright` invocation (i.e. once per `npm run test:e2e:*` run,
// before any spec).
//
// What it does:
//   1. Verifies the minimal-novel fixture exists + SHA matches the
//      sidecar (catches the case where someone forgot to regenerate
//      the fixture after editing the builder script).
//   2. Uploads the fixture to `/api/upload` (multipart).
//   3. Polls `/api/jobs` until the new job is `completed` (or fails).
//      Times out after 90s so a broken worker doesn't hang the suite.
//   4. Polls `/api/library` for the new Book row matching the
//      fixture's title. The match is by exact title
//      ("Tiểu Thuyết Tối Giản (E2E)") so we don't trip on older
//      leftover runs.
//   5. Writes the resolved book to `e2e/.seed-book.json` so specs
//      can read it via `loadSeededFixtureBook()` from `helpers.ts`.
//
// If the stack is healthy this finishes in ~3-5 seconds (worker is
// warm). If preflight already failed (no /api/library, no worker),
// this throws loudly so the suite aborts with a useful error.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures');
const FIXTURE_PATH = path.join(FIXTURE_ROOT, 'minimal-novel.epub');
const SHA_PATH = FIXTURE_PATH + '.sha256';
const SEED_FILE = path.resolve(__dirname, '.seed-book.json');
const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const FIXTURE_TITLE = 'Tiểu Thuyết Tối Giản (E2E)';
const FIXTURE_AUTHOR = 'Bộ Kiểm Thử';
const UPLOAD_TIMEOUT_MS = 90_000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  fetchFn: () => Promise<T | null>,
  isDone: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fetchFn();
    if (v !== null && isDone(v)) return v;
    await wait(1_000);
  }
  throw new Error(
    `seed-fixture: timed out waiting for ${label} after ${timeoutMs}ms. ` +
    `Check that the worker is running and the database is reachable.`,
  );
}

export default async function globalSetup() {
  // 1. Fixture integrity check.
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(
      `seed-fixture: missing fixture EPUB at ${FIXTURE_PATH}. ` +
      `Regenerate with 'node scripts/build-minimal-epub-fixture.mjs'.`,
    );
  }
  if (!fs.existsSync(SHA_PATH)) {
    throw new Error(`seed-fixture: missing SHA256 sidecar at ${SHA_PATH}.`);
  }
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const computed = createHash('sha256').update(bytes).digest('hex');
  const sidecar = fs.readFileSync(SHA_PATH, 'utf8').trim().split(/\s+/)[0];
  if (computed !== sidecar) {
    throw new Error(
      `seed-fixture: SHA256 mismatch.\n` +
      `  on-disk: ${computed}\n` +
      `  sidecar: ${sidecar}\n` +
      `Regenerate the sidecar with 'node scripts/build-minimal-epub-fixture.mjs'.`,
    );
  }

  // 2. Check whether the library already has the fixture loaded from
  //    a previous E2E run. If so, reuse it (cheap path) instead of
  //    uploading again. This keeps `start_full_app.sh + second E2E
  //    run` scenarios fast.
  const libraryBefore = await fetch(`${BASE_URL}/api/library?limit=200`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [] as Array<{ id: string; title: string; author: string }>);
  const existing = (libraryBefore as Array<{ id: string; title: string; author: string }>)
    .find((b) => b.title === FIXTURE_TITLE && b.author === FIXTURE_AUTHOR);

  let bookId: string;
  if (existing) {
    bookId = existing.id;
  } else {
    // 2b. Upload via multipart.
    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes], { type: 'application/epub+zip' }),
      'minimal-novel.epub',
    );
    form.append('aiEnhance', 'false');
    form.append('aiWatermarkClean', 'false');
    form.append('deepFormat', 'false');
    form.append('readerFriendly', 'true');

    const uploadResp = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      body: form,
    });
    if (!uploadResp.ok) {
      throw new Error(
        `seed-fixture: /api/upload failed: ${uploadResp.status} ${await uploadResp.text()}`,
      );
    }
    const uploadJson = await uploadResp.json() as { jobId: string };
    if (!uploadJson.jobId) {
      throw new Error('seed-fixture: /api/upload did not return a jobId');
    }
    const jobId = uploadJson.jobId;

    // 3. Wait for the conversion job to reach a terminal state. Polling
    //    /api/jobs?limit=200 and filtering by id is cheaper than
    //    hitting /api/jobs/[jobId] (which may not exist as a route).
    await pollUntil(
      async () => {
        const list = await fetch(`${BASE_URL}/api/jobs?limit=200`).then((r) => r.ok ? r.json() : []);
        const job = (list as Array<{ id: string; status: string }>).find((j) => j.id === jobId);
        return job ?? null;
      },
      (job) => job.status === 'completed' || job.status === 'failed',
      UPLOAD_TIMEOUT_MS,
      `conversion job ${jobId}`,
    );
    const finalJob = await fetch(`${BASE_URL}/api/jobs?limit=200`)
      .then((r) => r.ok ? r.json() : [])
      .then((list) => (list as Array<{ id: string; status: string }>).find((j) => j.id === jobId));
    if (!finalJob || finalJob.status !== 'completed') {
      throw new Error(
        `seed-fixture: job ${jobId} ended in status ${finalJob?.status ?? 'unknown'} — ` +
        `check worker logs to see why the conversion failed.`,
      );
    }

    // 4. Find the freshly-registered Book row by title.
    bookId = await pollUntil(
      async () => {
        const list = await fetch(`${BASE_URL}/api/library?limit=200`)
          .then((r) => r.ok ? r.json() : []);
        const match = (list as Array<{ id: string; title: string; author: string }>)
          .find((b) => b.title === FIXTURE_TITLE && b.author === FIXTURE_AUTHOR);
        return match?.id ?? null;
      },
      (id): id is string => typeof id === 'string' && id.length > 0,
      30_000,
      'library row matching fixture title',
    );
  }

  // 5. Persist the resolved book ID for the spec runtime.
  fs.writeFileSync(
    SEED_FILE,
    JSON.stringify({
      id: bookId,
      title: FIXTURE_TITLE,
      author: FIXTURE_AUTHOR,
      seededAt: new Date().toISOString(),
    }, null, 2) + '\n',
  );

  // Hand the book ID to child specs via env so existing
  // `process.env.E2E_BOOK_ID` paths continue to work.
  process.env.E2E_BOOK_ID = bookId;
}
