import { NextRequest, NextResponse } from 'next/server';

// Uses the local OMLX (Qwen3 reasoning model) to classify the emotional tone of
// a Vietnamese text paragraph.  This is SLOW (~30-90 s depending on text length)
// so it should be called in the background, not in the hot path of TTS playback.
// Client-side heuristic detection in EbookReader.tsx is the fast path.

const OMLX_BASE = (process.env.OMLX_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const OMLX_KEY  = process.env.OMLX_API_KEY ?? '';
// Model resolution priority (matches character detection):
//   1. Settings.aiModel (user-selected in /settings)
//   2. OMLX_MODEL env var (deployment default)
//   3. Empty — lets OMLX pick its server-side default instead of throwing
//      "Model 'default' not found" when nothing is configured.
async function resolveModel(): Promise<string> {
  try {
    const { getSettings } = await import('@/lib/db/settings');
    const s = await getSettings();
    return s.aiModel?.trim() || process.env.OMLX_MODEL || '';
  } catch {
    return process.env.OMLX_MODEL || '';
  }
}

const PROMPT_SYSTEM = 'Return ONLY valid JSON. No explanations.';
const PROMPT_USER   = (text: string) =>
  `/nothink\nClassify emotion of this Vietnamese text. Return JSON only: ` +
  `{"emotion":"excited|sad|tense|romantic|angry|calm|neutral","intensity":0.0-1.0}\n\nText: "${text}"`;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json() as { text?: string };
  const text = (body.text ?? '').trim().slice(0, 500);
  if (!text) {
    return NextResponse.json({ emotion: 'neutral', intensity: 0.5 });
  }

  // Resolve the user-selected model from Settings (per-call so it always
  // reflects the latest /settings choice without a server restart).
  const model = await resolveModel();

  try {
    const resp = await fetch(`${OMLX_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OMLX_KEY ? { Authorization: `Bearer ${OMLX_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: PROMPT_SYSTEM },
          { role: 'user',   content: PROMPT_USER(text) },
        ],
        max_tokens: 2000,
        temperature: 0.0,
      }),
      // 90 s timeout — the model needs time to reason then output JSON
      signal: AbortSignal.timeout(90_000),
    });

    if (!resp.ok) {
      return NextResponse.json({ emotion: 'neutral', intensity: 0.5 });
    }

    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';

    // The reasoning model outputs its thinking then the final JSON.
    // We grab the LAST JSON object in the response.
    const matches = [...content.matchAll(/\{[^{}]+\}/g)];
    const lastMatch = matches[matches.length - 1]?.[0];
    if (lastMatch) {
      const parsed = JSON.parse(lastMatch) as { emotion?: string; intensity?: number };
      return NextResponse.json({
        emotion:   parsed.emotion   ?? 'neutral',
        intensity: parsed.intensity ?? 0.5,
      });
    }
  } catch {
    // timeout or network error — fall through to neutral
  }

  return NextResponse.json({ emotion: 'neutral', intensity: 0.5 });
}
