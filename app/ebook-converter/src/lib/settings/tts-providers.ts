// src/lib/settings/tts-providers.ts
//
// Client-safe TTS provider catalog. Must NOT import anything that pulls
// in Prisma, node-fetch, or any `node:*` builtins — `src/app/settings/page.tsx`
// is a client component (`'use client'`) and bundling the server-only chain
// (db/settings → image-generator → omlx-client → node-fetch → node:buffer/http/...)
// into the client build fails with `UnhandledSchemeError` at `npm run build`.
//
// 2026-08-30: split out of src/lib/db/settings.ts to break the client/server
// import cycle introduced when TTS_PROVIDERS was centralized into the DB
// helper module.

export type TTSProvider = 'vieneu' | 'f5';

export const TTS_PROVIDERS: Array<{ id: TTSProvider; label: string; desc: string }> = [
  { id: 'vieneu',  label: 'VieNeu-TTS',          desc: 'Vietnamese-native, 10 built-in voices, voice cloning' },
  { id: 'f5',      label: 'F5-TTS (Vietnamese)', desc: 'Zero-shot cloning — 2 reference voices (Hồng Đào / Ngọc Ngân), runs on this Mac via MLX' },
];
