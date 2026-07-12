// Test that the new richer designCoverConcept prompt works correctly
// for the user's actual books.
import { detectGenre, toArtDirection } from '../src/lib/covers/genre-detector.ts';

const KEY = '68a569ecfa66fc00f241bc9e789c3b2808702f7b8eff6e97';
const URL = 'http://localhost:8080/v1/chat/completions';

const books = [
  { title: 'Thành Tựu Tiên Đế, Toàn Bộ Nhờ Địch Nhân Cố Gắng', author: 'Mộc Xuân' },
  { title: 'Ta Có Thần Cấp Sửa Chữa Khí', author: 'Vân Phật' },
  { title: 'Chiếm Đoạt Vợ Yêu', author: 'Tiểu Ngôn' },
];

for (const b of books) {
  const detection = detectGenre({ title: b.title });
  const art = toArtDirection(detection);
  console.log(`\n========== "${b.title}" — ${art.en} ==========`);

  // Build the SAME system prompt as designCoverConcept does now:
  const systemPrompt = `You are a Vietnamese-novel cover art director. Generate the JSON cover concept for the book provided by the user.

Mandatory fields the JSON MUST include:
- imagePrompt (string, English only, 80-180 words) — concrete SCENE description for an image-generation model. NO text in the image. Phrase it as a single vivid paragraph covering: setting/architecture, the central subject, mood/lighting, artistic style (e.g. "cinematic photo", "digital painting", "ink wash with color accents", "oil painting"), and a colour palette. Use English-only words; do NOT include any Vietnamese characters in this field.
- tagline (string, Vietnamese, 2-6 words) — a short evocative subtitle. Empty string "" if not applicable.
- style (enum) — must be one of: ink | watercolor | painting | cinematic | sketch
- accent (string hex) — accent colour for the title. Suggested for this genre: ${art.accent}
- textColor (string hex) — title colour ("#ffffff" for dark backgrounds, "#1a1a2e" for light)
- background (enum "dark" | "light") — already known for this genre to be ${art.bgDark ? '"dark"' : '"light"'}; please use exactly that.

Hard rules:
- Cover is ALWAYS in FULL COLOUR.
- imagePrompt MUST be English-only.
- DO NOT include any text, watermark, logo, signature, border, or scroll.
- DO NOT translate anything to English in any field other than imagePrompt.

Genre art direction for this book:
- Genre: ${art.vi} (${art.en})
- Suggested style: ${art.style}
- Motif anchor: ${art.motif}
- Mood: ${art.mood}
- Palette: ${art.paletteDescription}`;

  const userMessage = `Sách: "${b.title}" — ${b.author}\nNgôn ngữ: vi\n\nJSON concept:`;

  try {
    const resp = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'MLX-Qwen3.5-9B-DeepSeek-V4-Flash-4bit',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
        temperature: 0.6,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });
    if (!resp.ok) { console.log('  HTTP error:', resp.status); continue; }
    const j = await resp.json();
    const content = j?.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(content);
    console.log('  style (LLM picked):', parsed.style, ' (recommended:', art.style + ')');
    console.log('  background:', parsed.background);
    console.log('  accent:', parsed.accent, '/', parsed.textColor);
    console.log('  imagePrompt (first 120 chars):', (parsed.imagePrompt ?? '').slice(0, 120) + '...');
    const hasVi = /[ăâêôơưđáàảãạắằẳẵặếềểễệốồổỗộớờởỡợứừửữựíìỉĩịýỳỷỹỵ]/i.test(parsed.imagePrompt ?? '');
    console.log('  has Vietnamese:', hasVi, hasVi ? '⚠️  WILL FALLBACK' : '✓');
  } catch (e) {
    console.log('  Error:', e.message);
  }
}
