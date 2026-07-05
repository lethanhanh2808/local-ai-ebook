// Backfill script — re-run the detector PER-CHAPTER on a book's epub,
// merge gender/tone across chapters, and re-pick each character's voice
// using gender-aware scoring.
//
// Usage: node _backfill_gender.js <bookId>
//
// Why per-chapter (vs the default 5-chapter strided sample)?
// The detector's default `MAX_CHAPTERS=5` strided-sampling can miss
// characters that only appear later in the book. Per-chapter detection
// ensures every chapter is scanned; we then merge by name to dedupe.
//
// set -a; source .env.local; set +a   before running.

const fs = require('fs');
const path = require('path');
const {PrismaClient} = require('@prisma/client');
const {spawnSync} = require('child_process');

const BOOK_ID = process.argv[2];
if (!BOOK_ID) {
  console.error('Usage: node _backfill_gender.js <bookId>');
  process.exit(1);
}

const p = new PrismaClient();
const PY = '/Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service/.venv-moss-nano/bin/python';
const HELPER = path.join(__dirname, '_backfill_helper.py');

(async () => {
  const book = await p.book.findUnique({where:{id:BOOK_ID}});
  if (!book) { console.error('Book not found'); process.exit(1); }
  console.log(`Backfilling gender/tone + voice for: ${book.title}`);
  console.log(`EPUB: ${book.filePath}`);

  const proc = spawnSync(PY, [HELPER, book.filePath], {
    env: process.env,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (proc.stderr) process.stderr.write(proc.stderr);
  if (proc.status !== 0) {
    console.error('Python helper failed');
    process.exit(1);
  }
  const out = JSON.parse(proc.stdout);
  console.log(`Per-chapter detection: ${out.per_chapter.length} chapters scanned`);
  for (const pc of out.per_chapter) {
    console.log(`  - ${pc.chapter}: ${pc.count} characters`);
  }
  console.log(`Total unique characters across all chapters: ${out.total_unique}`);
  console.log(`Detected characters:`);
  for (const c of out.merged) {
    console.log(`  - ${c.name} g=${c.gender} a=${c.age} t=${c.tone} aliases=[${(c.aliases || []).join(', ')}]`);
  }

  // Build lookup by lowercase name + alias
  const detectedByName = new Map();
  for (const c of out.merged) {
    detectedByName.set(c.name.toLowerCase(), c);
    for (const a of c.aliases || []) detectedByName.set(a.toLowerCase(), c);
  }

  // Smart lookup: an existing character name (or alias) may appear as a
  // SUBSTRING of a detected character name (or alias). E.g. existing
  // "Long" should match detected "Y Đằng Long" because "long" is the
  // tail of "y đằng long". And the other direction: detected "Y Đằng Long"
  // might be an alias of an existing row whose primary name is also
  // "Y Đằng Long" — exact match wins, but if no exact match, fall back to
  // a substring / token-overlap check.
  function findMatch(existingName, existingAliases) {
    const targetLc = existingName.toLowerCase();
    const aliasLc = (existingAliases || []).map(a => a.toLowerCase());
    // 1) exact name match
    if (detectedByName.has(targetLc)) return detectedByName.get(targetLc);
    // 2) exact alias match
    for (const a of aliasLc) if (detectedByName.has(a)) return detectedByName.get(a);
    // 3) substring: existing name appears at end of detected name (e.g. "Long" in "Y Đằng Long")
    for (const [detName, detObj] of detectedByName) {
      if (detName.endsWith(' ' + targetLc) || detName === targetLc) return detObj;
    }
    // 4) substring: detected name appears at end of existing alias
    for (const detName of Object.keys(detectedByName)) {
      for (const a of aliasLc) {
        if (a.endsWith(' ' + detName) || detName === a) return detectedByName.get(detName);
      }
    }
    // 5) alias-set overlap: existing.name is one of detected.aliases
    for (const c of out.merged) {
      if ((c.aliases || []).some(a => a.toLowerCase() === targetLc)) return c;
    }
    // 6) alias-set overlap: detected.name is one of existing.aliases
    for (const c of out.merged) {
      const cn = c.name.toLowerCase();
      if (cn === targetLc || aliasLc.includes(cn)) return c;
    }
    return null;
  }

  // Fetch existing characters for this book
  const existing = await p.character.findMany({where:{bookId:BOOK_ID}, include:{voice:true}});
  console.log(`Existing characters: ${existing.length}`);

  // Voice profiles (mirror of VIENEU_PROFILES in src/lib/ai/voice-selector.ts)
  const PROFILES = [
    {name:'Ngọc Linh', gender:'female', age:'young',   tone:'cheerful',  energy:'high'},
    {name:'Ngọc Lan',  gender:'female', age:'mature',  tone:'calm',      energy:'low'},
    {name:'Mỹ Duyên',  gender:'female', age:'mature',  tone:'calm',      energy:'low'},
    {name:'Trúc Ly',   gender:'female', age:'young',   tone:'cheerful',  energy:'high'},
    {name:'Bình An',   gender:'male',   age:'mature',  tone:'calm',      energy:'low'},
    {name:'Gia Bảo',   gender:'male',   age:'mature',  tone:'calm',      energy:'low'},
    {name:'Đức Trí',   gender:'male',   age:'mature',  tone:'serious',   energy:'medium'},
    {name:'Thái Sơn',  gender:'male',   age:'young',   tone:'cold',      energy:'low'},
    {name:'Trọng Hữu', gender:'male',   age:'mature',  tone:'mysterious',energy:'medium'},
    {name:'Xuân Vĩnh', gender:'male',   age:'young',   tone:'cheerful',  energy:'high'},
  ];

  function score(prof, char) {
    let s = 0;
    const g = (char.gender || '').toLowerCase();
    if (g === 'male' || g === 'female') {
      s += (prof.gender === g) ? 10 : -20;
    }
    const a = (char.age || '').toLowerCase();
    if (a === 'young' || a === 'mature' || a === 'old') {
      s += (prof.age === a) ? 3 : 0;
    }
    const t = (char.tone || '').toLowerCase();
    if (t && t !== 'unknown') s += (prof.tone === t) ? 5 : 0;
    return s;
  }

  function pickVoice(char) {
    const scored = PROFILES.map(pr => ({pr, s: score(pr, char)}));
    scored.sort((a, b) => b.s - a.s);
    return scored[0].pr;
  }

  // Ensure built-in voices exist for the book
  const voices = await p.voice.findMany({where:{bookId:BOOK_ID}});
  const voicesByName = new Map(voices.map(v => [v.name, v]));
  for (const profile of PROFILES) {
    if (!voicesByName.has(profile.name)) {
      const v = await p.voice.create({
        data: {
          bookId: BOOK_ID,
          name: profile.name,
          refAudioPath: '',
          language: 'vi',
          isDefault: false,
          description: `Built-in VieNeu voice: ${profile.name} (${profile.gender}/${profile.age}/${profile.tone})`,
          kind: 'character',
          builtinName: profile.name,
        },
      });
      voicesByName.set(v.name, v);
    }
  }

  // ── Name-only gender heuristics (for characters the detector missed) ──
  // Vietnamese feminine suffixes (Mai, Túy, Hoa, Linh, Lan, Trang, Nhi,
  // Mỹ, Trúc, Ngân, Na, ...) and Japanese "Maiko" all strongly imply
  // female. "người đàn ông" = man = male. Anything else stays null.
  const FEMALE_NAME_HINTS = [
    'túy', 'mai', 'hoa', 'linh', 'lan', 'trang', 'nhi', 'mỹ', 'trúc',
    'ngân', 'na', 'quyên', 'vy', 'thư', 'tâm', 'hồng', 'phương',
    'yến', 'thảo', 'nga', 'hà', 'loan', 'hương', 'tú', 'ly', 'diệu',
  ];
  const MALE_NAME_HINTS = [
    'sơn', 'hải', 'đạt', 'tùng', 'cường', 'đức', 'trí', 'hưng', 'văn',
    'vũ', 'khôi', 'long', 'bảo', 'an', 'phú', 'quý', 'minh', 'hiếu',
  ];
  // Special-case full names
  const isFemaleFullName = (name) => {
    const lc = name.toLowerCase();
    if (lc.includes('người phụ nữ') || lc.includes('bà ') || lc.startsWith('bà ')) return true;
    if (lc.includes('cô gái')) return true;
    if (lc === 'maiko') return true;  // Japanese, female
    return false;
  };
  const isMaleFullName = (name) => {
    const lc = name.toLowerCase();
    if (lc.includes('người đàn ông') || lc.includes('ông ')) return true;
    if (lc.startsWith('ông ')) return true;
    return false;
  };
  function genderFromName(name, aliases) {
    const allNames = [name, ...(aliases || [])].map(s => s.toLowerCase());
    if (allNames.some(isFemaleFullName)) return 'female';
    if (allNames.some(isMaleFullName)) return 'male';
    if (allNames.some(n => FEMALE_NAME_HINTS.some(h => n.endsWith(h) || n.endsWith(' ' + h)))) return 'female';
    if (allNames.some(n => MALE_NAME_HINTS.some(h => n.endsWith(h) || n.endsWith(' ' + h)))) return 'male';
    return null;
  }

  let updated = 0, voiceChanged = 0, genderSet = 0;
  const changes = [];
  for (const c of existing) {
    const aliases = c.aliases ? JSON.parse(c.aliases) : [];
    const det = findMatch(c.name, aliases);
    if (!det) {
      // Try name-based heuristic before giving up
      const heurGender = genderFromName(c.name, aliases);
      if (!heurGender) {
        console.log(`  - skip ${c.name} (not detected, name ambiguous)`);
        continue;
      }
      console.log(`  + ${c.name}: name-heuristic gender=${heurGender}`);
      const newGender = heurGender;
      const newTone   = c.tone ?? null;
      const newAge    = c.age  ?? null;
      if (newGender && newGender !== c.gender) genderSet++;

      let newVoiceId = c.voiceId;
      let newBuiltin = c.voice?.builtinName || c.voice?.name;
      if (newGender && newGender !== 'unknown') {
        const ideal = pickVoice({gender: newGender, age: newAge, tone: newTone});
        if (ideal.name !== newBuiltin) {
          const v = voicesByName.get(ideal.name);
          if (v) {
            newVoiceId = v.id;
            newBuiltin = ideal.name;
            voiceChanged++;
            changes.push(`  ! ${c.name}: gender=${newGender} (name-heuristic) → voice "${ideal.name}" (was "${c.voice?.builtinName || c.voice?.name || 'none'}")`);
          }
        }
      }

      await p.character.update({
        where: { id: c.id },
        data: {
          gender: newGender,
          tone: newTone,
          age: newAge,
          ...(newVoiceId !== c.voiceId ? { voiceId: newVoiceId } : {}),
        },
      });
      updated++;
      continue;
    }
    const detectedGender = (det.gender && det.gender !== 'unknown') ? det.gender : null;
    const detectedTone   = (det.tone   && det.tone   !== 'unknown') ? det.tone   : null;
    const detectedAge    = det.age ?? null;

    // ── Sanity check: detector hallucinations ──
    // If the existing character has a known female Vietnamese name suffix
    // but the detector returned male, prefer the name-based heuristic.
    // The detector occasionally hallucinates gender for characters it
    // barely saw in the sample.
    const heurGender = genderFromName(c.name, aliases);

    let newGender = detectedGender || c.gender || null;
    let newTone   = detectedTone   || c.tone   || null;
    let newAge    = detectedAge    || c.age    || null;

    if (detectedGender === 'male' && heurGender === 'female') {
      console.log(`  ~ overriding ${c.name}: detector said male but name is female`);
      newGender = 'female';
    }
    if (detectedGender === 'female' && heurGender === 'male') {
      console.log(`  ~ overriding ${c.name}: detector said female but name is male`);
      newGender = 'male';
    }
    if (newGender && newGender !== c.gender) genderSet++;

    let newVoiceId = c.voiceId;
    let newBuiltin = c.voice?.builtinName || c.voice?.name;
    if (newGender && newGender !== 'unknown') {
      const ideal = pickVoice({gender: newGender, age: newAge, tone: newTone});
      if (ideal.name !== newBuiltin) {
        const v = voicesByName.get(ideal.name);
        if (v) {
          newVoiceId = v.id;
          newBuiltin = ideal.name;
          voiceChanged++;
          changes.push(`  ! ${c.name}: gender=${newGender}, age=${newAge}, tone=${newTone} → voice "${ideal.name}" (was "${c.voice?.builtinName || c.voice?.name || 'none'}")`);
        }
      }
    }

    await p.character.update({
      where: { id: c.id },
      data: {
        gender: newGender,
        tone: newTone,
        age: newAge,
        ...(newVoiceId !== c.voiceId ? { voiceId: newVoiceId } : {}),
      },
    });
    updated++;
  }

  console.log('');
  changes.forEach(s => console.log(s));
  console.log('');
  console.log(`Updated ${updated} characters; ${voiceChanged} voice assignments changed; ${genderSet} genders newly set.`);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });