#!/usr/bin/env node
// scripts/preview-cover-prompt.mjs
//
// Print the cover-art design prompt the generator would send to the
// text AI for a given title. Use this when you want to sanity-check
// what the system thinks a book is, and how it'll describe the cover.
//
//   node scripts/preview-cover-prompt.mjs "Chiếm Đoạt Vợ Yêu"
//   node scripts/preview-cover-prompt.mjs "Ta Có Thần Cấp Sửa Chữa Khí"
//
import { detectGenre, toArtDirection } from '../src/lib/covers/genre-detector.ts';

const title = process.argv.slice(2).join(' ');
if (!title) {
  console.error('Usage: node scripts/preview-cover-prompt.mjs "<title>"');
  process.exit(1);
}

const detection = detectGenre({ title });
const art = toArtDirection(detection);

console.log(`\n  Title:    "${title}"`);
console.log(`  Detected: ${detection.genre} (${detection.spec.en}) — ${(detection.confidence * 100).toFixed(0)}% confidence`);
console.log(`  Hits:     ${detection.matchedKeywords.join(', ') || '(none)'}`);
console.log(`\n  Art direction the AI will be given:`);
console.log(`  • Style:        ${art.style}`);
console.log(`  • Motif:        ${art.motif}`);
console.log(`  • Mood:         ${art.mood}`);
console.log(`  • Palette:      ${art.paletteDescription}`);
console.log(`  • Accent:       ${art.accent}`);
console.log(`  • Bg brightness:${art.bgDark ? 'dark' : 'light'}`);
console.log(`\n  Fallback imagePrompt (used if LLM fails):`);
console.log(`  ${art.fallbackImagePrompt}\n`);
