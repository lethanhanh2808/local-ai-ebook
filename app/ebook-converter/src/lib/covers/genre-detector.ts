// src/lib/covers/genre-detector.ts
//
// Vietnamese-novel genre detector for AI cover generation.
//
// Why this exists:
//   `designCoverConcept()` in ai-generate-cover.ts used to ask the text
//   AI to infer the book's genre from title + description alone and pick
//   a visual style accordingly. For titles with strong genre signals
//   (e.g. "Tiên Đế", "Tu Tiên", "Vợ Yêu") the LLM did fine. But three
//   failure modes were real on the user's library:
//
//     1. Romance titles ("Chiếm Đoạt Vợ Yêu") hit context loops and
//        emitted garbled JSON. The genre inference is OBVIOUS from the
//        title alone, so it shouldn't depend on a 9B chat model.
//     2. Tu tiểu thuyết titles sometimes got classified as "cinematic"
//        when they wanted "ink" / "painting" — purely a matter of
//        which style enum the LLM picked, not the visual concept.
//     3. The `imagePrompt` field occasionally leaked Vietnamese. MiniMax
//        and OpenAI image generators are tuned on English captions;
//        Vietnamese prompts degrade the result.
//
// This module gives the LLM a *strong, deterministic seed*:
//   - Genre keyword classifier over the title (and description if set)
//   - Per-genre visual direction so the LLM has a clear slot to fill
//   - Pre-built fallback imagePrompt for the case where the LLM service
//     is down or returns garbage (so we still ship a coherent cover).
//
// The LLM still owns the freeform scene description, but the structural
// decisions (genre → style → colour palette → composition motif) live
// in code so they're stable across regenerations.

import path from 'path';

// ── Genre vocabulary ──────────────────────────────────────────────────────
// Each genre carries:
//   - vi label    : human-readable Vietnamese label
//   - en label    : English label for the LLM/embedding model
//   - keywords    : high-confidence Vietnamese keywords (case-insensitive,
//                   word-boundary matches). Lower-case here.
//   - bonusKeywords: optional "supporting signals" that nudge the score
//                   but don't decisively pick the genre alone.
//   - style       : our cover-design `style` enum
//   - motif       : a concise English scene motif the LLM should anchor on
//   - palette     : suggested accent + bg brightness + colour description
//   - fallback    : an English imagePrompt we use if the LLM fails

export type VietnameseGenre =
  | 'tu_tieu_thuyet'      // tu tiên / kiếm hiệp / huyền huyễn cultivation
  | 'ngon_tinh'           // romance, especially modern/Vietnamese ngôn tình
  | 'lich_su'             // historical / cổ trang / cung đấu
  | 'do_thi'              // modern urban / business / mafia / đô thị
  | 'game_system'         // lit-RPG / system / hệ thống / level up
  | 'kinh_di'             // horror / supernatural scare
  | 'khoa_hoc_vien_tuong' // sci-fi / mecha / future tech
  | 'thieu_nien'          // thanh xuân / học đường (school / coming-of-age)
  | 'unknown';            // unclassified — let the LLM figure it out

interface GenreSpec {
  vi: string;
  en: string;
  /**
   * High-signal keywords — each hit is worth `weight` (default 2).
   * Multi-word and "specific" keywords are demoted only when there's
   * a real single-word tiebreaker (otherwise they win cleanly).
   */
  keywords: readonly string[];
  /**
   * Specific compound / disambiguating keywords that PROVE the genre
   * (e.g. "ma tộc" in tu tiểu thuyết disambiguates from kinh dị's
   * bare "ma"). Each hit is worth `weightStrong` (default 3).
   * Optional — most genres don't need it.
   */
  strongKeywords?: readonly string[];
  /**
   * Supporting signals — each hit is worth `bonusWeight` (default 0.5).
   * Use only for words that nudge the score but aren't definitive on
   * their own (e.g. "yêu", "tình" — they appear in many novel titles).
   */
  bonusKeywords?: readonly string[];
  style: 'ink' | 'painting' | 'watercolor' | 'cinematic' | 'sketch';
  motif: string;
  palette: { accent: string; bgDark: boolean; description: string };
  mood: string;
  fallbackImagePrompt: string;
}

export const GENRE_SPECS: Record<VietnameseGenre, GenreSpec> = {
  tu_tieu_thuyet: {
    vi: 'Tu tiên / Kiếm hiệp / Huyền huyễn',
    en: 'Cultivation / Wuxia / Xianxia',
    keywords: [
      'tu tiên', 'tu luyện', 'tu vi', 'tu sĩ',
      'tiên đế', 'tiên tử', 'tiên giới', 'tiên phủ',
      'kiếm tu', 'kiếm đế', 'kiếm ý', 'kiếm pháp', 'kiếm tông',
      'độ kiếp', 'đan điền', 'đan dược',
      'tông môn', 'tông chủ', 'môn phái', 'môn chủ',
      'pháp bảo', 'pháp thuật', 'pháp lực',
      'huyền huyễn',
      'linh khí', 'linh căn', 'cảnh giới', 'đại lao',
      'hoàng tộc', 'tổ địa', 'gia tộc',
      'lục giới', 'tam giới',
      'phượng', 'long', 'hổ', 'phượng hoàng',
      // "phàm nhân" is a signature cultivation term.
      'phàm nhân',
    ],
    // Compound / disambiguating terms — these PROVE tu tiểu thuyết over
    // kinh dị / ngôn tình when matched. Worth 3 points each, vs 2 for
    // the regular keywords. "ma tộc" in the title, for example, is a
    // cultivation demon-clan novel, not a horror novel — the compound
    // form is what tells them apart.
    strongKeywords: [
      'ma tộc', 'yêu tộc', 'huyết tộc', 'thần tộc',
      'tiên tộc', 'long tộc', 'phượng tộc',
      'ma đế', 'ma vương', 'yêu đế', 'yêu vương', 'tà đế',
      'tà đế', 'thánh đế', 'ma thần',
    ],
    bonusKeywords: ['bắt đầu', 'xuyên qua', 'trùng sinh', 'hack'],
    style: 'ink',
    mood: 'epic / mystical',
    motif: 'misty mountain peak with ancient cultivator, jade-green aura, floating celestial palace',
    palette: { accent: '#c89b3c', bgDark: true, description: 'jade green / gold / misty white' },
    fallbackImagePrompt: 'A lone immortal cultivator in flowing Hanfu-style robes meditating on the peak of a misty mountain, jade-green energy swirling around them, ancient celestial palace floating in the clouds above, golden koi fish swimming through the mist, dramatic ink-wash painting style with subtle color accents, deep jade-green and gold color palette, epic and mystical mood',
  },
  ngon_tinh: {
    vi: 'Ngôn tình (lãng mạn)',
    en: 'Romance',
    // We deliberately avoid the bare words "yêu" / "tình" as primary
    // — they're too broad and match cultivation titles too. Use the
    // strong ngôn tình signals (vợ yêu, cô vợ, chiếm đoạt, tổng tài, ...)
    // and keep bare "yêu" / "tình" as supporting bonus signals only.
    keywords: [
      'vợ yêu', 'cô vợ', 'vợ cả', 'tiểu vợ', 'vợ anh',
      'anh chồng',
      'phu xin', 'phu nhân', 'phu quân',
      'chiếm đoạt', 'cưới', 'cưới vợ', 'cưới chồng',
      'hôn nhân', 'đám cưới',
      'thiếp',
      'thiếu gia', 'thiếu nữ', 'tiểu thư',
      'boss là', 'tổng tài', 'tgđ',
      'ngôn tình', 'ngọt', 'ngược',
      'cô ấy', 'anh ấy',
      'ngự', 'chiếu hồn',
    ],
    bonusKeywords: ['yêu', 'tình', 'ngọt ngào', 'lãng mạn'],
    style: 'watercolor',
    mood: 'romantic / soft',
    motif: 'couple silhouette in warm golden-hour light, soft floral motifs, traditional Vietnamese áo dài or modern elegant outfits',
    palette: { accent: '#d4a373', bgDark: false, description: 'warm sepia / dusty rose / soft gold' },
    fallbackImagePrompt: 'A romantic backlit silhouette of a young couple embracing in a garden of cherry blossoms at golden hour, soft warm light filtering through the petals, delicate floral patterns drifting in the air, painterly watercolor style with soft brushwork, warm sepia and dusty rose color palette, romantic and tender mood',
  },
  lich_su: {
    vi: 'Cổ trang / Lịch sử / Cung đấu',
    en: 'Historical / Costume drama',
    keywords: [
      'cổ trang', 'lịch sử', 'cung đình', 'cung đấu',
      'triều đại', 'triều', 'hoàng đế', 'hoàng hậu',
      'công chúa', 'hoàng tử',
      'thái giám', 'phi tần', 'hậu cung',
      'vương triều', 'thế tử',
      'phủ', 'phủ quân',
    ],
    bonusKeywords: ['áo dài'],
    style: 'painting',
    mood: 'regal / historical',
    motif: 'ornate imperial palace courtyard with red lacquer pillars and golden phoenix motifs, figures in flowing silk robes',
    palette: { accent: '#a82c2c', bgDark: true, description: 'vermilion red / imperial gold / jade' },
    fallbackImagePrompt: 'An ornate imperial palace courtyard at dusk, carved vermilion pillars framing a ceremonial walkway, golden phoenix motifs catching the last warm light, distant lotus ponds reflecting lantern glow, two figures in flowing silk Hanfu standing under a curved bridge, classical Chinese oil painting style with rich vermilion and imperial gold palette, regal and historical mood',
  },
  do_thi: {
    vi: 'Đô thị / Hiện đại / Kinh doanh',
    en: 'Modern urban / Business',
    keywords: [
      'đô thị', 'thành phố', 'hiện đại',
      'kinh doanh', 'tài chính',
      'doanh nhân', 'tổng giám đốc', 'tgđ',
      'mafia', 'xã hội đen', 'bang hội',
      'yêu râu xanh', 'quyền lực',
      'đại gia', 'tài phiệt',
      'công ty', 'thương trường',
      'ngôn tình ngược', 'ngôn tình sủng',
    ],
    style: 'cinematic',
    mood: 'modern / urban',
    motif: 'skyline of Ho Chi Minh City at night with neon reflections, a stylish couple under umbrella in the rain, modern glass architecture',
    palette: { accent: '#0ea5e9', bgDark: true, description: 'electric cyan / neon teal / steel grey' },
    fallbackImagePrompt: 'A modern city skyline at dusk with sleek glass skyscrapers glowing in neon cyan and teal, rain-slicked streets reflecting shimmering lights, a stylish couple sharing an umbrella on a pedestrian bridge in the foreground, cinematic photography style with shallow depth of field, modern urban mood',
  },
  game_system: {
    vi: 'Game / Hệ thống / LitRPG',
    en: 'Game / System / LitRPG',
    keywords: [
      'hệ thống', 'hệ thống tu luyện', 'bảng hệ thống',
      'trò chơi', 'game over',
      'level up', 'lên cấp', 'cấp bậc',
      'kỹ năng', 'chiến đấu thẻ bài', 'kỹ năng bị động',
      'thần cấp', 'sửa chữa khí', 'sửa chữa',
      'bảng thông số', 'bảng trạng thái',
      'nâng cấp', 'cường hóa',
      'phó bản', 'thương hội', 'vật phẩm',
      'tẩy điểm', 'cộng điểm',
    ],
    bonusKeywords: ['bắt đầu', 'sống lại', 'trọng sinh'],
    style: 'cinematic',
    mood: 'epic / power-fantasy',
    motif: 'ethereal floating skill tree with glowing runes, warrior surrounded by spiraling energy, lens flare',
    palette: { accent: '#a78bfa', bgDark: true, description: 'electric purple / neon cyan / white' },
    fallbackImagePrompt: 'A powerful young warrior surrounded by a swirling vortex of electric purple and cyan energy, glowing rune symbols orbiting around them like a halo, a translucent skill-tree floating in the background with ascending power levels, epic cinematic composition with dramatic rim lighting, modern game-cinematic style, power-fantasy mood',
  },
  kinh_di: {
    vi: 'Kinh dị / Ma / Quỷ',
    en: 'Horror / Supernatural',
    keywords: [
      'kinh dị', 'ma quỷ', 'quỷ', 'ma',
      'ác quỷ', 'ác mộng',
      'rùng rợn',
      'thây ma', 'zombie',
      'bóng ma', 'hồn ma',
      'nhà ma', 'nghĩa địa',
      'khủng bố', 'rợn',
    ],
    style: 'painting',
    mood: 'dark / haunting',
    motif: 'abandoned courtyard shrouded in fog, twisted trees, single ominous lantern, ghostly figure barely visible',
    palette: { accent: '#7f1d1d', bgDark: true, description: 'deep crimson / ash grey / dark moss' },
    fallbackImagePrompt: 'An ancient Vietnamese abandoned courtyard shrouded in heavy fog, twisted banyan trees with gnarled roots, a single red lantern casting eerie crimson light on crumbling stone walls, a barely visible ghostly figure in white áo dài floating near the gate, dark oil painting style with deep crimson and ash grey palette, haunting and chilling mood',
  },
  khoa_hoc_vien_tuong: {
    vi: 'Khoa học viễn tưởng / Tương lai',
    en: 'Sci-fi / Futuristic',
    keywords: [
      'khoa học viễn tưởng', 'viễn tưởng',
      'không gian', 'vũ trụ', 'tàu vũ trụ',
      'robot', 'mecha', 'android',
      'tương lai', 'cyberpunk',
      'hành tinh', 'thiên hà',
      'chiến đấu cơ', 'phi thuyền',
    ],
    style: 'cinematic',
    mood: 'futuristic / epic',
    motif: 'enormous space station orbiting a teal-and-gold planet, lone astronaut in foreground, lens flare',
    palette: { accent: '#22d3ee', bgDark: true, description: 'deep space blue / cyan / silver' },
    fallbackImagePrompt: 'A lone astronaut standing on an observation deck, a colossal teal-and-gold ringed space station orbiting behind them, distant nebula glowing with electric cyan and silver light, volumetric god rays, cinematic sci-fi film composition with anamorphic lens flares, futuristic and awe-inspiring mood',
  },
  thieu_nien: {
    vi: 'Thanh xuân / Học đường',
    en: 'Youth / School life',
    keywords: [
      'thanh xuân', 'học đường', 'học sinh',
      'trường học', 'trường',
      'thiếu niên',
      'bạn học', 'lớp học',
      'crush',
    ],
    style: 'watercolor',
    mood: 'youthful / bright',
    motif: 'sunlit high-school courtyard, cherry-blossom-lined path, two students on a wooden bench',
    palette: { accent: '#f9a8d4', bgDark: false, description: 'soft pink / sky blue / warm sunlight' },
    fallbackImagePrompt: 'A sunlit high school courtyard in late spring, rows of blooming sakura trees lining a brick path, two students in uniform sitting on a wooden bench by a fountain, warm afternoon light casting long shadows, soft watercolor painting style with delicate brushwork, bright pink and sky blue palette, youthful and tender mood',
  },
  unknown: {
    vi: 'Khác / Tổng hợp',
    en: 'Unknown / Mixed',
    keywords: [],
    style: 'cinematic',
    mood: 'mysterious / neutral',
    motif: 'abstract gradient with subtle floating elements, no specific subject',
    palette: { accent: '#c89b3c', bgDark: true, description: 'neutral warm gold with deep moody tones' },
    fallbackImagePrompt: 'An elegant abstract cinematic composition, deep moody warm tones with a soft golden glow center-stage and subtle floating particles in the foreground, evocative of mystery and storytelling without a specific subject, professional book cover composition with strong visual hierarchy',
  },
};

// ── Detection ────────────────────────────────────────────────────────────

export interface GenreDetection {
  genre: VietnameseGenre;
  /** Score 0..1; lower means less confident. Caller may retry with
   *  LLM fallback when score < threshold. */
  confidence: number;
  /** Matched keyword(s) that drove the decision — useful for logging. */
  matchedKeywords: string[];
  spec: GenreSpec;
}

/** Unicode-aware "word boundary" regex. JS's built-in `\b` only
 *  matches ASCII word boundaries (a-z, 0-9, _) — Vietnamese diacritic
 *  letters (\p{L}) trip it up, so a `/\bma tộc\b/i` search against
 *  input `"Ma Tộc ..."` returns false even though the substring is
 *  right there. We use look-behind/look-ahead instead, matching
 *  either start/end of input OR a non-letter / non-digit character.
 *  Works uniformly for single-word AND multi-word keywords.
 */
function escapedMatchRegex(kw: string): RegExp {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=[^\\p{L}\\p{N}]|$)`, 'iu');
}

/** Count the number of times `kw` appears as a standalone token in
 *  `input`. Respects Vietnamese-diacritic boundaries. */
function countKeywordHits(input: string, kw: string): number {
  const re = escapedMatchRegex(kw);
  const matches = input.match(new RegExp(re.source, 'giu'));
  return matches ? matches.length : 0;
}

/** Count keyword matches across BOTH the diacritics version (`norm`)
 *  and the diacritics-stripped version (`strippedNorm`), but dedupe
 *  positions so we don't double-count the same physical occurrence.
 *
 *  Why: when the input is `"Ma Tộc"`, the diacritic phrase "ma tộc"
 *  matches in `norm` ONCE (at position 0). The same input, after
 *  stripping diacritics, becomes `"ma toc"` — "ma" still matches there.
 *  Without dedup, the simple-wildcard "ma" keyword would be counted
 *  twice (once from each pass) for the same single occurrence, which
 *  distorts the score. We dedupe by match-position. */
function countAcrossPasses(norm: string, strippedNorm: string, kw: string): number {
  // Try the diacritic version first.
  const normMatches = norm.match(new RegExp(escapedMatchRegex(kw).source, 'giu'));
  const positions = new Set<number>();
  if (normMatches) for (const m of normMatches) positions.add(norm.indexOf(m));

  // If the diacritic-pass already found something, the stripped pass
  // would match the SAME substring anyway, so skip it. This avoids
  // inflating the count for short keywords like "ma" against titles
  // like "Ma Tộc".
  if (positions.size > 0) return positions.size;

  // Fall back to the stripped version only when nothing matched.
  const strippedMatches = strippedNorm.match(new RegExp(escapedMatchRegex(kw).source, 'giu'));
  if (!strippedMatches) return 0;
  let count = 0;
  let i = 0;
  for (const m of strippedMatches) {
    const idx = strippedNorm.indexOf(m, i);
    if (idx >= 0) { count++; i = idx + m.length; }
  }
  return count;
}

/** Light-weight diacritics-stripping so titles with mismatched
 *  diacritics (e.g. user typed "Bat Dau" instead of "Bắt Đầu") still
 *  match common keywords. Used as a SECOND pass after the primary
 *  strip-aware match. */
function stripped(input: string): string {
  const map: Record<string, string> = {
    'ă': 'a', 'â': 'a', 'á': 'a', 'à': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
    'ắ': 'a', 'ằ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
    'ê': 'e', 'é': 'e', 'è': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
    'ế': 'e', 'ề': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
    'ô': 'o', 'ơ': 'o', 'ó': 'o', 'ò': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
    'ố': 'o', 'ồ': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
    'ớ': 'o', 'ờ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
    'ư': 'u', 'ú': 'u', 'ù': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
    'ứ': 'u', 'ừ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
    'đ': 'd', 'Đ': 'd',
    'í': 'i', 'ì': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
    'ý': 'y', 'ỳ': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
  };
  return input.replace(/[ăâáàảãạắằẳẵặêéèẻẽẹếềểễệôơóòỏõọốồổỗộớờởỡợưúùủũụứừửữựđĐíìỉĩịýỳỷỹỵ]/g,
    c => map[c.toLowerCase()] ?? c.toLowerCase());
}

export interface GenreDetectionInput {
  title?: string | null;
  titleVi?: string | null;
  description?: string | null;
  publisher?: string | null;
  /** Optional explicit override from the user / a previous run.
   *  Accepts our enum values (`tu_tieu_thuyet`, ...) or the
   *  free-text Vietnamese label (`"Tu tiên"`). */
  hint?: VietnameseGenre | string | null;
}

/** Map a free-text user hint (Vietnamese label OR our enum OR
 *  common English names) to our enum. Returns null when no match. */
function normaliseHint(hint: string | null | undefined): VietnameseGenre | null {
  if (!hint) return null;
  const h = hint.trim().toLowerCase();
  if (!h) return null;
  // Direct enum match.
  if (h in GENRE_SPECS) return h as VietnameseGenre;
  // Vietnamese label fragment match.
  const aliasMap: Record<string, VietnameseGenre> = {
    'tu tiên': 'tu_tieu_thuyet', 'tu tien': 'tu_tieu_thuyet',
    'kiếm hiệp': 'tu_tieu_thuyet', 'kiem hiep': 'tu_tieu_thuyet',
    'huyền huyễn': 'tu_tieu_thuyet', 'huyen huyen': 'tu_tieu_thuyet',
    'tiên hiệp': 'tu_tieu_thuyet', 'tien hiep': 'tu_tieu_thuyet',
    'cultivation': 'tu_tieu_thuyet', 'wuxia': 'tu_tieu_thuyet', 'xianxia': 'tu_tieu_thuyet',
    'ngôn tình': 'ngon_tinh', 'ngon tinh': 'ngon_tinh',
    'romance': 'ngon_tinh', 'ngọt': 'ngon_tinh',
    'lịch sử': 'lich_su', 'lich su': 'lich_su',
    'cổ trang': 'lich_su', 'co trang': 'lich_su',
    'cung đấu': 'lich_su', 'cung dau': 'lich_su',
    'historical': 'lich_su', 'costume drama': 'lich_su',
    'đô thị': 'do_thi', 'do thi': 'do_thi',
    'urban': 'do_thi', 'modern': 'do_thi',
    'hệ thống': 'game_system', 'he thong': 'game_system',
    'game': 'game_system', 'litrpg': 'game_system',
    'kinh dị': 'kinh_di', 'kinh di': 'kinh_di',
    'horror': 'kinh_di',
    'khoa học viễn tưởng': 'khoa_hoc_vien_tuong',
    'sci-fi': 'khoa_hoc_vien_tuong', 'scifi': 'khoa_hoc_vien_tuong',
    'thanh xuân': 'thieu_nien', 'thanh xuan': 'thieu_nien',
    'học đường': 'thieu_nien', 'hoc duong': 'thieu_nien',
    'youth': 'thieu_nien',
  };
  return aliasMap[h] ?? null;
}

/** Detect the most likely Vietnamese-novel genre from the available
 *  metadata, returning a deterministic seed we feed to the LLM. */
export function detectGenre(input: GenreDetectionInput): GenreDetection {
  const corpus = [
    input.titleVi,
    input.title,
    input.description,
    input.publisher,
  ].filter(Boolean).join(' · ');

  // Honour an explicit hint above all (user override via API).
  const hintGenre = normaliseHint(input.hint);
  if (hintGenre) {
    const spec = GENRE_SPECS[hintGenre];
    return {
      genre: hintGenre,
      confidence: 1,
      matchedKeywords: ['explicit-hint'],
      spec,
    };
  }

  if (!corpus.trim()) {
    const spec = GENRE_SPECS.unknown;
    return { genre: 'unknown', confidence: 0, matchedKeywords: [], spec };
  }

  const norm = corpus.toLowerCase();
  const strippedNorm = stripped(norm);

  const scores: Array<{ genre: VietnameseGenre; score: number; hits: string[] }> = [];
  for (const [genre, spec] of Object.entries(GENRE_SPECS) as Array<[VietnameseGenre, GenreSpec]>) {
    if (genre === 'unknown') continue;

    let score = 0;
    const hits: string[] = [];
    // Strong (compound / disambiguating) keywords are worth 3 points
    // each — they prove the genre, so they break ties in their favour.
    if (spec.strongKeywords) {
      for (const kw of spec.strongKeywords) {
        const c = countAcrossPasses(norm, strippedNorm, kw);
        if (c > 0) {
          score += c * 3;
          hits.push(kw);
        }
      }
    }
    for (const kw of spec.keywords) {
      const c = countAcrossPasses(norm, strippedNorm, kw);
      if (c > 0) {
        score += c * 2;
        hits.push(kw);
      }
    }
    if (spec.bonusKeywords) {
      for (const kw of spec.bonusKeywords) {
        const c = countAcrossPasses(norm, strippedNorm, kw);
        if (c > 0) score += c * 0.5;
      }
    }

    // Penalty when corpus is very short (title only, no description);
    // a 1-hit score on a 1-word title is fragile.
    if (corpus.length < 30) score *= 0.6;

    scores.push({ genre, score, hits });
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const runnerUp = scores[1];

  if (!top || top.score < 1) {
    return {
      genre: 'unknown',
      confidence: 0,
      matchedKeywords: [],
      spec: GENRE_SPECS.unknown,
    };
  }

  // Confidence = share of total + margin from runner-up.
  const total = scores.reduce((s, e) => s + e.score, 0) || 1;
  const margin = runnerUp ? (top.score - runnerUp.score) / Math.max(1, total) : 1;
  const conf = Math.min(1, top.score / Math.max(1, total) * 2 + margin * 0.3);

  return {
    genre: top.genre,
    confidence: conf,
    matchedKeywords: top.hits.slice(0, 5),
    spec: GENRE_SPECS[top.genre],
  };
}

/** A small bundle the cover API route / worker can pass straight to
 *  the LLM call — keeps call sites from re-deriving the prompt. */
export interface GenreArtDirection {
  vi: string;
  en: string;
  style: GenreSpec['style'];
  motif: string;
  mood: string;
  accent: string;
  bgDark: boolean;
  paletteDescription: string;
  fallbackImagePrompt: string;
}

export function toArtDirection(detection: GenreDetection): GenreArtDirection {
  const s = detection.spec;
  return {
    vi: s.vi,
    en: s.en,
    style: s.style,
    motif: s.motif,
    mood: s.mood,
    accent: s.palette.accent,
    bgDark: s.palette.bgDark,
    paletteDescription: s.palette.description,
    fallbackImagePrompt: s.fallbackImagePrompt,
  };
}

// Keep the unused-import warning quiet — `path` is reserved for
// future work that loads keyword sets from JSON on disk so we don't
// have to recompile when the taxonomy changes.
void path;
