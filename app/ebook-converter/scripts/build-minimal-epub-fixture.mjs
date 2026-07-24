#!/usr/bin/env node
// scripts/build-minimal-epub-fixture.mjs
//
// Build a deterministic MINIMAL EPUB fixture for Playwright E2E.
// Phase 4.1 of `docs/NEXT_UP_PLAN.md` — gives the E2E suite a stable,
// committed target so the smoke + GUI tests don't need to depend on a
// real book sitting in the user's library.
//
//   node scripts/build-minimal-epub-fixture.mjs
//
// Spec (deliberately smaller than the `samples/fixture-illustrated-
// novel.epub` Phase 2 fixture so E2E can boot fast and so it doesn't
//   trigger the full conversion pipeline):
//
//   * NO cover image
//   * NO interior images
//   * NO data-URI inline images
//   * 1 chapter with ~10 short paragraphs of deterministic Vietnamese
//     prose. Enough text to exercise the reader split, sliceParagraphs,
//     attribution, and TTS end-to-end without needing a real long book.
//   * Minimal OPF metadata: dc:title, dc:creator, dc:language, dc:identifier,
//     dcterms:modified (frozen timestamp so bytes are reproducible).
//   * No cover.xhtml page (no `class="cover-page"` body — keeps the
//     Phase 2.4 "no cover pages sneak in as Chapter 1" fix still
//     triggered/observable in E2E).
//   * EPUB3 spine with a single <itemref>.
//
// All bytes are deterministic: fixed timestamp, fixed identifier, no
// sharp, no PNGs. Total output is ~3 KB and lives under
// `e2e/fixtures/minimal-novel.epub`.
//
// The script also writes a `.sha256` sidecar so the E2E suite can
// assert no accidental modifications before re-pointing at the fixture.
//
// Why a SECOND fixture (vs reusing `samples/fixture-illustrated-novel.epub`):
//   * The Phase 2 fixture is 21 KB with 4 chapters + 4 images — overkill
//     for smoke tests that just need "the reader loads, the audio
//     tab opens, the editor opens". Bigger fixture → slower E2E
//     boots → harder to gate as a daily check.
//   * E2E spec needs to be deterministic and independent of "what
//     books the user happens to have in their library". A committed
//     fixture owned by the test suite is the answer.
//   * The plan keeps the two fixtures separate so future image-
//     preservation work doesn't accidentally bump the minimal fixture.

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Pin under `e2e/fixtures/` so the test suite owns it (samples/ is for
// production-pipeline fixtures; e2e/fixtures/ is for test fixtures).
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'e2e/fixtures/minimal-novel.epub');
const SHA_PATH = OUTPUT_PATH + '.sha256';

// ── Constants (frozen for byte-stability) ───────────────────────────────────

const IDENTIFIER = 'urn:uuid:e2e-minimal-novel-2026-07-24';
const TITLE = 'Tiểu Thuyết Tối Giản (E2E)';
const AUTHOR = 'Bộ Kiểm Thử';
const LANGUAGE = 'vi';
const MODIFIED_DATE = '2026-07-24T00:00:00Z';
const CHAPTER_ID = 'ch001';
const CHAPTER_FILE = 'ch001.xhtml';
const CHAPTER_TITLE = 'Chương 1: Buổi sáng';

// ── XML helpers ─────────────────────────────────────────────────────────────

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 10 deterministic paragraphs of Vietnamese prose. Varied length so
// sliceParagraphs() sees something more interesting than uniform
// lorem ipsum. Conversations are intentionally NOT included — E2E
// spec for character detection is a separate concern (and depends on
// a real roster); this fixture exists to exercise the reader, the
// editor, and basic attribution round-trips.
const CHAPTER_BODY = `
<p>Chương một bắt đầu vào một buổi sáng mùa thu tĩnh lặng. Sương sớm
còn phủ trên mái ngói, tiếng gà gáy vang lên từ phía xa xa. Nhân vật
chính — bà Lan — đang ngồi bên bậu cửa, nhìn ra vườn trúc phía sau
nhà. Trà đã nguội từ lâu, nhưng bà vẫn chưa muốn vào trong.</p>

<p>Hôm qua có một bức thư từ người con trai đi xa. Bà đã đọc đi đọc
lại nhiều lần. Trong thư, con trai kể rằng nơi anh sống bây giờ có
rất nhiều hoa anh đào. Hoa nở vào tháng ba, rơi xuống sân trường
như một trận mưa trắng. Anh nói anh nhớ bà, nhớ vườn trúc nhà
mình, nhớ cả tiếng gà gáy mỗi sớm.</p>

<p>Bà Lan gấp bức thư lại, cẩn thận đặt vào hộp gỗ mà bà vẫn giữ
trên bàn. Bên trong hộp đã có rất nhiều thư cũ. Bà không bao giờ
vứt đi thư nào.</p>

<p>Bỗng có tiếng chó sủa phía cổng. Bà đứng dậy, vịn tay vào khung
cửa. Một người đàn ông trung niên mặc áo dài đen đang đứng ngoài
cổng, tay cầm theo chiếc giỏ tre nhỏ. Bà nhận ra ngay — đó là anh
Hai, người cháu họ mà bà chưa gặp lại từ mùa hè năm ngoái.</p>

<p>Bà vội bước ra mở cổng. Anh Hai cúi đầu chào, niềm nở hỏi thăm.
Bà mời anh vào nhà, rót trà mới. Hai người ngồi bên nhau, nhìn ra
vườn trúc, kể cho nhau nghe về một năm đã qua. Ngoài trời, sương
đã tan dần. Nắng bắt đầu lên cao trên đỉnh trúc.</p>

<p>Anh Hai lấy trong giỏ ra mấy chiếc bánh tét. Bà cười, nói "Sao
biết bà thích bánh tét thế?" Anh Hai bảo đây là bánh do chính
tay anh làm, vốn chỉ để ăn thử trong dịp tết, nhưng anh muốn mang
cho bà một ít. Bà cảm động, bảo anh Hai là người biết để ý.</p>

<p>Hai người cùng ăn bánh, cùng uống trà. Bà nói về thằng con trai,
anh Hai bảo anh có gặp nó ngoài Hà Nội vào tháng trước. Nó vẫn
khỏe, vẫn vui, vẫn hay nhắc tới bà. Bà Lan nghe xong thì cười,
nhưng đôi mắt lại rưng rưng.</p>

<p>Buổi chiều hôm đó, anh Hai cáo từ ra về. Bà đứng ở hiên nhà nhìn
theo. Chiếc giỏ tre giờ trống không, được bà giữ lại như kỷ vật.
Bà bước vào trong, đóng cửa, và lại ngồi vào chỗ cũ bên bậu cửa.
Bầu trà lại nguội — và bà lại không muốn vào trong.</p>

<p>Chương một khép lại ở đó. Không có gì thêm xảy ra. Chỉ có buổi sáng,
bức thư, người cháu họ, chiếc giỏ tre, và rất nhiều trà uống dở.
Nhưng với bà Lan, đó đã là một buổi sáng đầy ắp.</p>
`;

// ── Builders ────────────────────────────────────────────────────────────────

function buildChapterXhtml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="vi">
<head><meta charset="utf-8"/><title>${escapeXml(CHAPTER_TITLE)}</title></head>
<body>
  <section id="${CHAPTER_ID}" epub:type="chapter" role="doc-chapter">
    <h1 id="${CHAPTER_ID}-title" epub:type="title">${escapeXml(CHAPTER_TITLE)}</h1>
    ${CHAPTER_BODY.trim()}
  </section>
</body>
</html>
`;
}

function buildNav() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="vi">
<head><meta charset="utf-8"/><title>${escapeXml(TITLE)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Mục lục</h1>
    <ol>
      <li><a href="Text/${CHAPTER_FILE}">${escapeXml(CHAPTER_TITLE)}</a></li>
    </ol>
  </nav>
</body>
</html>
`;
}

function buildOpf() {
  // Minimal OPF: one chapter, no cover, no images, EPUB3.
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${IDENTIFIER}</dc:identifier>
    <dc:title>${escapeXml(TITLE)}</dc:title>
    <dc:creator>${escapeXml(AUTHOR)}</dc:creator>
    <dc:language>${LANGUAGE}</dc:language>
    <meta property="dcterms:modified">${MODIFIED_DATE}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="${CHAPTER_ID}" href="Text/${CHAPTER_FILE}" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="${CHAPTER_ID}"/>
  </spine>
</package>
`;
}

function buildContainerXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opf = buildOpf();
  const nav = buildNav();
  const chapter = buildChapterXhtml();
  const containerXml = buildContainerXml();

  // Order matters: mimetype must be the FIRST entry, uncompressed.
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', { compress: false });
  zip.addBuffer(Buffer.from(containerXml, 'utf8'), 'META-INF/container.xml');
  zip.addBuffer(Buffer.from(opf, 'utf8'),         'OEBPS/content.opf');
  zip.addBuffer(Buffer.from(nav, 'utf8'),         'OEBPS/nav.xhtml');
  zip.addBuffer(Buffer.from(chapter, 'utf8'),      `OEBPS/Text/${CHAPTER_FILE}`);
  zip.end();

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  const bytes = await new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });

  writeFileSync(OUTPUT_PATH, bytes);

  // SHA256 sidecar — written AFTER the EPUB so the hash matches.
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(SHA_PATH, `${sha}  ${path.basename(OUTPUT_PATH)}\n`);

  const kb = (bytes.length / 1024).toFixed(2);
  console.log(`✓ Wrote ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} (${kb} KB, ${bytes.length} bytes, 5 entries)`);
  console.log(`  SHA256: ${sha}`);
  console.log(`  Sidecar: ${path.relative(PROJECT_ROOT, SHA_PATH)}`);
}

main().catch((err) => {
  console.error('build-minimal-epub-fixture.mjs failed:', err);
  process.exit(1);
});
