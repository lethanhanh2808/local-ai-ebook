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
  /**
   * Per-book variety axes — see "Cover variety" below.
   *
   * Each variant array holds 2-4 alternative scene fragments that live
   * in the SAME genre world but describe DIFFERENT subjects, shots,
   * lighting moods, or palette accents. At cover-build time we pick
   * one entry from each axis deterministically (from title+author hash)
   * so two books in the same genre never produce the same cover.
   *
   * The legacy single-value fields (`motif`, `palette`, `fallbackImagePrompt`)
   * MUST remain in sync with `variant[0]` of each axis — they're
   * still used as the canonical "this is what genre X looks like"
   * description in logs and the system prompt header.
   *
   *   motifVariants[0]      === motif (single-value field)
   *   paletteVariants[0]    === palette (single-value field)
   *
   * The `fallbackImagePrompt` is composed by templating the picked
   * motif / shot / lighting / palette into a single sentence — see
   * `composeFallbackPrompt()`.
   */
  motifVariants: string[];
  shotVariants: string[];
  lightingVariants: string[];
  paletteVariants: Array<{ accent: string; description: string }>;
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
    // Variety axes — same genre world, different subjects/compositions
    // per book so two tu_tieu_thuyet books don't look like the same
    // template. Picked deterministically by title+author hash.
    motifVariants: [
      // 0 — keeps legacy single-value `motif` (back-compat)
      'misty mountain peak with ancient cultivator, jade-green aura, floating celestial palace',
      // 1 — different subject in the same world
      'colossal ancient sword thrust into the ground of a jade-green valley, lightning cracking around its runic blade',
      // 2 — another subject
      'floating jade pagoda suspended over an abyss of swirling clouds, a lone sword cultivator leaping between stone platforms',
    ],
    shotVariants: [
      'wide establishing shot, subject centered with vast negative space',
      'low-angle hero shot looking up at the subject against dramatic sky',
      'close-up of an iconic object (sword / talisman / scroll) with depth-of-field bokeh background',
    ],
    lightingVariants: [
      'pre-dawn blue hour, soft purple-gold rim light on the subject',
      'high noon with volumetric god-rays piercing through clouds',
      'moonlit night with silver-blue rim and warm lantern accents',
    ],
    paletteVariants: [
      // 0 — legacy palette (back-compat)
      { accent: '#c89b3c', description: 'jade green / gold / misty white' },
      // 1 — cool-shifted sister palette
      { accent: '#5fb3a8', description: 'deep teal / silver / pale jade' },
    ],
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
    motifVariants: [
      'couple silhouette in warm golden-hour light, soft floral motifs, traditional Vietnamese áo dài or modern elegant outfits',
      'lone woman in flowing áo dài walking across a rain-soaked bridge lit by paper lanterns',
      'two hands almost touching across a sun-dappled café table, scattered rose petals, soft bokeh',
    ],
    shotVariants: [
      'medium portrait, subject waist-up with shallow depth-of-field',
      'wide cinematic shot of an empty romantic setting (bridge, garden, balcony)',
      'overhead flat-lay of symbolic objects (letter, dried flower, locket) with soft shadows',
    ],
    lightingVariants: [
      'golden hour, warm backlight with lens flare',
      'overcast soft daylight, even illumination, pastel tones',
      'twilight, cool blue ambient with warm window-light accents',
    ],
    paletteVariants: [
      { accent: '#d4a373', description: 'warm sepia / dusty rose / soft gold' },
      { accent: '#c08497', description: 'dusty rose / blush pink / cream' },
    ],
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
    motifVariants: [
      'ornate imperial palace courtyard with red lacquer pillars and golden phoenix motifs, figures in flowing silk robes',
      'distant Forbidden-City skyline at dawn, embroidered banners catching the first warm light, a single rider on horseback crossing the great marble bridge',
      'imperial throne room in deep perspective, jade scepters and bronze ceremonial vessels on either side, a single robed silhouette ascending the steps',
    ],
    shotVariants: [
      'wide establishing shot of the palace complex from a distance',
      'interior medium shot framed by carved columns and hanging silk drapes',
      'low-angle hero shot of a single figure ascending ceremonial stairs',
    ],
    lightingVariants: [
      'dusk with warm vermilion lantern glow and long indigo shadows',
      'midday with bright cloud-diffused light, vivid saturated reds',
      'moonlit night with silver highlights on the gilded roof tiles',
    ],
    paletteVariants: [
      { accent: '#a82c2c', description: 'vermilion red / imperial gold / jade' },
      { accent: '#7a1a2e', description: 'deep crimson / antique gold / bronze' },
    ],
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
    motifVariants: [
      'skyline of Ho Chi Minh City at night with neon reflections, a stylish couple under umbrella in the rain, modern glass architecture',
      'sleek black luxury sedan parked under a wet overpass, neon signage reflecting in the puddles, no figures',
      'rooftop infinity pool at dusk with the city skyline in the background, a single suited silhouette at the railing',
    ],
    shotVariants: [
      'wide cinematic cityscape with the subject small in the frame for scale',
      'eye-level street shot, shallow depth-of-field with bokeh city lights',
      'high-angle aerial perspective looking down on a rain-slicked intersection',
    ],
    lightingVariants: [
      'rainy night with neon reflections and rim-lit silhouettes',
      'golden hour with long shadows and warm building glow',
      'overcast daylight with diffused soft shadows, muted saturation',
    ],
    paletteVariants: [
      { accent: '#0ea5e9', description: 'electric cyan / neon teal / steel grey' },
      { accent: '#fb923c', description: 'amber streetlight / warm orange / charcoal' },
    ],
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
    motifVariants: [
      'ethereal floating skill tree with glowing runes, warrior surrounded by spiraling energy, lens flare',
      'lone swordsman standing before a colossal transparent stat-sheet HUD projecting their level and power, neon glyphs cascading down',
      'boss arena interior with a swirling purple portal of loot drops and skill upgrades, the hero silhouetted at the threshold',
    ],
    shotVariants: [
      'wide hero shot, subject centered with full skill-tree behind them',
      'extreme close-up of a glowing rune / weapon detail with bokeh background',
      'low-angle silhouette against a backdrop of cascading neon glyphs',
    ],
    lightingVariants: [
      'dramatic purple/cyan rim light with volumetric energy haze',
      'flat neon billboard lighting, saturated cyberpunk palette',
      'cool blue moonlight base with one warm orange accent highlight',
    ],
    paletteVariants: [
      { accent: '#a78bfa', description: 'electric purple / neon cyan / white' },
      { accent: '#22d3ee', description: 'electric cyan / hot magenta / white' },
    ],
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
    motifVariants: [
      'abandoned courtyard shrouded in fog, twisted trees, single ominous lantern, ghostly figure barely visible',
      'long dark staircase descending into a flooded temple crypt, water reflecting a single flickering candle, no figures',
      'cracked ancestral altar with three extinguished incense sticks, a lone spirit-candle burning blue, offerings half-decayed',
    ],
    shotVariants: [
      'wide symmetric shot down a corridor or staircase with subject centered',
      'close-up of a single iconic object (lantern / talisman / doll) with bokeh darkness',
      'low-angle hero shot of a ghostly silhouette emerging from shadow',
    ],
    lightingVariants: [
      'single warm lantern glow surrounded by deep blue-black darkness',
      'cold blue moonlight with hard-edged shadows',
      'foggy diffused grey light, low contrast, oppressive atmosphere',
    ],
    paletteVariants: [
      { accent: '#7f1d1d', description: 'deep crimson / ash grey / dark moss' },
      { accent: '#1f2937', description: 'midnight indigo / bone white / cold teal' },
    ],
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
    motifVariants: [
      'enormous space station orbiting a teal-and-gold planet, lone astronaut in foreground, lens flare',
      'colossal mech silhouette standing at the edge of an alien megacity, holographic billboards reflecting off chrome armor',
      'cylindrical rotating space habitat with city lights visible through its transparent hull, a single cargo ship approaching',
    ],
    shotVariants: [
      'wide establishing shot with subject tiny against a vast celestial backdrop',
      'over-the-shoulder hero shot looking out from a cockpit window',
      'extreme wide shot of a megacity or space structure in silhouette',
    ],
    lightingVariants: [
      'cold cyan starlight with one warm orange window-light accent',
      'nebula-glow with magenta and violet gradient sky',
      'harsh sunlight on chrome, deep saturated contrast',
    ],
    paletteVariants: [
      { accent: '#22d3ee', description: 'deep space blue / cyan / silver' },
      { accent: '#a78bfa', description: 'violet nebula / chrome / hot pink' },
    ],
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
    motifVariants: [
      'sunlit high-school courtyard, cherry-blossom-lined path, two students on a wooden bench',
      'rooftop at golden hour, a single student leaning on the railing with a backpack, city skyline behind them',
      'school library aisle, late afternoon sun streaming between bookshelves, an open notebook on the windowsill',
    ],
    shotVariants: [
      'medium shot of two students from a slight distance, environmental',
      'overhead flat-lay of a desk scattered with textbooks, stationery, and a half-eaten bento',
      'tracking shot of an empty school corridor with sunlight stripes on the floor',
    ],
    lightingVariants: [
      'late-afternoon golden hour with long warm shadows',
      'overcast soft daylight, even and gentle',
      'sunrise with cool blue air and warm rim light',
    ],
    paletteVariants: [
      { accent: '#f9a8d4', description: 'soft pink / sky blue / warm sunlight' },
      { accent: '#fde68a', description: 'cream / sage green / powder blue' },
    ],
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
    motifVariants: [
      'abstract gradient with subtle floating elements, no specific subject',
      'soft-focus macro of a single symbolic object (compass / feather / candle) on a dark surface',
      'silhouetted figure seen from behind, walking into a fog-shrouded horizon with one warm light source',
    ],
    shotVariants: [
      'wide cinematic composition with strong negative space',
      'extreme close-up of a single textured surface with bokeh',
      'medium shot, subject centered with vignetted edges',
    ],
    lightingVariants: [
      'single warm key light from off-camera, deep moody shadows',
      'overcast soft daylight, low contrast',
      'twilight with cool ambient and one warm accent highlight',
    ],
    paletteVariants: [
      { accent: '#c89b3c', description: 'neutral warm gold with deep moody tones' },
      { accent: '#64748b', description: 'slate grey / muted teal / off-white' },
    ],
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

// ── Cover variety ───────────────────────────────────────────────────────
//
// Two books in the same genre used to look like the same template:
// every tu_tieu_thuyet novel got "misty mountain peak + jade aura + gold
// ink", every lich_su novel got "imperial courtyard + vermilion pillars"
// etc. The single `motif` / `palette` / `fallbackImagePrompt` fields
// converged the LLM onto the same image every time.
//
// Each genre now ships 4 axes of variants:
//   - motifVariants      (2-3 subjects in the same world)
//   - shotVariants       (composition / framing)
//   - lightingVariants   (atmosphere / time of day)
//   - paletteVariants    (1-2 colour-shifted accents)
//
// At cover-build time we pick ONE entry from each axis deterministically
// from title+author. The combination is unique per book, so two
// tu_tieu_thuyet novels with different titles never produce the same
// cover — but they still feel like the same genre (jade / gold / mist
// for tu tiên, vermilion / imperial for lich_su, etc.).
//
// We use the SAME salt-stamped hash the cover-seed already uses
// (see coverSeed in ai-generate-cover.ts), so variant picks stay in
// lock-step with the image-generation seed: same book always gets the
// same cover, even across process restarts.

/** Pick a stable 0..total-1 index from `title|author|axis`. Each axis
 *  uses its own salt so the picked indices don't correlate across axes
 *  (otherwise every book would pick the same (motif, shot, lighting)
 *  triple because their hashes would always have the same high bits).
 *
 *  Uses DJB2-style hash for parity with `coverSeed()`. Returns 0 when
 *  `total <= 1` so callers don't have to guard. */
function pickVariantIndex(title: string, author: string, axis: string, total: number): number {
  if (total <= 1) return 0;
  const s = `${title}|${author}|cover-v5-variant-axis:${axis}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0) % total;
}

/** The four axes we vary per book. Order matters — different axes get
 *  different salts in `pickVariantIndex` so they don't correlate. */
export type VarietyAxis = 'motif' | 'shot' | 'lighting' | 'palette';

/** The picked set returned by `pickVariety()`. All fields are guaranteed
 *  populated — `palette` is just the resolved entry from `paletteVariants`. */
export interface PickedVariety {
  motif: string;
  shot: string;
  lighting: string;
  palette: { accent: string; description: string };
  /** Diagnostic indices, useful for logging ("this book picked motif=2,
   *  shot=1, lighting=0, palette=1"). */
  motifIndex: number;
  shotIndex: number;
  lightingIndex: number;
  paletteIndex: number;
}

/** Pick one entry from each variety axis, deterministically from
 *  `title + author`. Two books with the same title|author always get
 *  the same picks (same book → same cover). */
export function pickVariety(
  spec: GenreSpec,
  title: string,
  author: string,
): PickedVariety {
  const motifIndex = pickVariantIndex(title, author, 'motif', spec.motifVariants.length);
  const shotIndex = pickVariantIndex(title, author, 'shot', spec.shotVariants.length);
  const lightingIndex = pickVariantIndex(title, author, 'lighting', spec.lightingVariants.length);
  const paletteIndex = pickVariantIndex(title, author, 'palette', spec.paletteVariants.length);
  return {
    motif: spec.motifVariants[motifIndex],
    shot: spec.shotVariants[shotIndex],
    lighting: spec.lightingVariants[lightingIndex],
    palette: spec.paletteVariants[paletteIndex],
    motifIndex, shotIndex, lightingIndex, paletteIndex,
  };
}

/** Compose the deterministic fallback imagePrompt from the four picked
 *  variety axes. Replaces the legacy single hardcoded `fallbackImagePrompt`
 *  string. The sentence is templated to keep the same general structure
 *  (subject + composition + lighting + style + palette + mood) so the
 *  image AI sees a familiar shape regardless of which variants were
 *  picked — only the words inside the brackets change.
 *
 *  Example output (tu_tieu_thuyet, motif[1] / shot[0] / lighting[2] /
 *  palette[1]):
 *    "A colossal ancient sword thrust into the ground of a jade-green
 *     valley, lightning cracking around its runic blade. Wide establishing
 *     shot, subject centered with vast negative space. Moonlit night with
 *     silver-blue rim and warm lantern accents. Ink wash painting style.
 *     Deep teal / silver / pale jade palette. Epic and mystical mood." */
export function composeFallbackPrompt(
  spec: GenreSpec,
  picked: PickedVariety,
): string {
  const subjectFragment = capFirst(picked.motif);
  const compositionFragment = capFirst(picked.shot);
  const lightingFragment = capFirst(picked.lighting);
  // Style fragment names the genre's recipe so the image model picks
  // matching brushwork / filters. Falls back to "painterly composition"
  // if the style enum ever loses its image-side mapping.
  const styleName = styleToHumanName(spec.style);
  const paletteFragment = capFirst(picked.palette.description);
  return `${subjectFragment} ${compositionFragment} ${lightingFragment} ${styleName}, ${paletteFragment} palette. ${capFirst(spec.mood)} mood.`;
}

function capFirst(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function styleToHumanName(s: GenreSpec['style']): string {
  switch (s) {
    case 'ink':        return 'Ink wash painting style with subtle color accents';
    case 'watercolor': return 'Painterly watercolor style with soft brushwork';
    case 'painting':   return 'Classical oil painting style';
    case 'cinematic':  return 'Cinematic photography style with shallow depth of field';
    case 'sketch':     return 'Pencil sketch style with light shading';
  }
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
  /** Picked variants for this specific book. Always populated when
   *  `toArtDirection` is called with `title + author`. Falls back to
   *  the legacy single-value fields (variant index 0) when either is
   *  missing, so old call sites without title/author still work. */
  picked: PickedVariety;
}

/** Resolve the per-book art direction. Pass `title + author` to enable
 *  cover variety (different book → different cover); omit them only in
 *  legacy paths that haven't been updated yet — they'll get variant
 *  index 0 across the board, which matches the legacy single-value
 *  fields exactly (back-compat). */
export function toArtDirection(
  detection: GenreDetection,
  title?: string,
  author?: string,
): GenreArtDirection {
  const s = detection.spec;
  const picked = (title && author)
    ? pickVariety(s, title, author)
    : {
        motif: s.motifVariants[0],
        shot: s.shotVariants[0],
        lighting: s.lightingVariants[0],
        palette: s.paletteVariants[0],
        motifIndex: 0, shotIndex: 0, lightingIndex: 0, paletteIndex: 0,
      };
  return {
    vi: s.vi,
    en: s.en,
    style: s.style,
    // Use the PICKED motif as the headline — it's what varies per book.
    motif: picked.motif,
    mood: s.mood,
    accent: picked.palette.accent,
    bgDark: s.palette.bgDark,
    paletteDescription: picked.palette.description,
    // Compose the fallback from the picked variants instead of the
    // legacy single hardcoded string — this is the headline win for
    // variety because every book gets its own fallback when the LLM
    // design step fails.
    fallbackImagePrompt: composeFallbackPrompt(s, picked),
    picked,
  };
}

// ── Default title placement per genre ───────────────────────────────────────
//
// Picks where on the cover the title overlay should sit BEFORE the AI
// image is generated. The AI is told to leave that area empty so the
// final composite doesn't cover the main subject. After the image
// returns, ai-generate-cover.ts re-scores with pickTitlePlacement()
// from image-analysis.ts and may override this default.
//
// All genres currently prefer the bottom-horizontal band (matches
// the existing aesthetic). Vietnamese-novel covers universally use
// bottom-band titles, so this is a safe default. Future tuning can
// pin specific genres to vertical-side bands.
//
// Kept here (rather than in image-analysis.ts) so the genre-detection
// subsystem owns its full art-direction seed.

import type { TitlePlacement } from './image-analysis';

export const DEFAULT_PLACEMENT: Record<VietnameseGenre, TitlePlacement> = {
  tu_tieu_thuyet:      'h-bottom',
  ngon_tinh:           'h-bottom',
  lich_su:             'h-bottom',
  do_thi:              'h-bottom',
  game_system:         'h-bottom',
  kinh_di:             'h-bottom',
  khoa_hoc_vien_tuong: 'h-bottom',
  thieu_nien:          'h-bottom',
  unknown:             'h-bottom',
};

/** Pick a default placement using title length as the override signal.
 *  Long titles wrap awkwardly at the bottom; route them to a
 *  vertical-side band so each line stays short enough to read. */
export function pickInitialPlacement(
  title: string,
  genre: VietnameseGenre,
): TitlePlacement {
  if (title.length > 32) return 'v-right';
  if (title.length > 26) return 'v-left';
  return DEFAULT_PLACEMENT[genre];
}

// Keep the unused-import warning quiet — `path` is reserved for
// future work that loads keyword sets from JSON on disk so we don't
// have to recompile when the taxonomy changes.
void path;
