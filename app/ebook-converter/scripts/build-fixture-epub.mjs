#!/usr/bin/env node
// scripts/build-fixture-epub.mjs
//
// Build a deterministic illustrated EPUB fixture committed to
// `samples/fixture-illustrated-novel.epub`. The fixture gives the
// image-preservation work (and any future parser/builder regression
// tests) a stable target that doesn't depend on real-world EPUBs
// changing.
//
//   node scripts/build-fixture-epub.mjs
//
// Spec:
//   * 1 cover image  (OEBPS/Images/cover.png,   600×900)
//   * 2 figure images (OEBPS/Images/figure-1.png 300×200,
//                      OEBPS/Images/figure-2.png 300×200)
//   * 1 data-URI inline image embedded in chapter 2's HTML
//   * 4 chapters with varied body shapes:
//       - Ch 1: long prose, no images (control case)
//       - Ch 2: figure inline within a <p>
//       - Ch 3: figure as block between two <p>s
//       - Ch 4: short, no images (regression for short-chapter path)
//
// All bytes are deterministic: sharp-generated with constant colors,
// no timestamps embedded in the OPF, the script writes to a SHA256-
// stable path under samples/.
//
// Why a script rather than a hand-built static EPUB:
//   * The OPF + nav.xhtml + cover.xhtml are tedious to write by hand
//     and easy to typo. The script keeps them in one place and makes
//     the structure self-documenting.
//   * Future image-preservation tests can regenerate the fixture if
//     the structure needs to change, rather than hand-editing XML.

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'samples/fixture-illustrated-novel.epub');
const SHA_PATH = OUTPUT_PATH + '.sha256';

// ── Constants ────────────────────────────────────────────────────────────────

const IDENTIFIER = 'urn:uuid:fixture-illustrated-novel-2026-07-24';
const TITLE = 'Tiểu Thuyết Minh Họa Mẫu';
const AUTHOR = 'Bộ Kiểm Thử';
const LANGUAGE = 'vi';
const MODIFIED_DATE = '2026-07-24T00:00:00Z';

// Fixed colors for image generation — no machine variance.
const COLOR_COVER_BG = { r: 30,  g: 60,  b: 90  };
const COLOR_COVER_FG = { r: 240, g: 240, b: 255 };
const COLOR_FIGURE_1 = { r: 180, g: 60,  b: 60  };
const COLOR_FIGURE_2 = { r: 60,  g: 130, b: 60  };
const COLOR_DATA_URI = { r: 200, g: 160, b: 60  };

// ── Image generation ────────────────────────────────────────────────────────

function labelSvg(label, color, fg) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">` +
    `<rect width="100%" height="100%" fill="rgb(${color.r},${color.g},${color.b})"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="serif" font-size="48" fill="rgb(${fg.r},${fg.g},${fg.b})">${label}</text>` +
    `</svg>`,
  );
}

async function generatePng(label, color, fg, w, h) {
  return sharp(labelSvg(label, color, fg)).resize(w, h).png().toBuffer();
}

// Tiny inline data-URI PNG: a 50×50 single-color block, no label, for
// the data-URI test. Small enough to keep the fixture under 50 KB.
async function generateDataUriPng() {
  return sharp({
    create: { width: 50, height: 50, channels: 3, background: COLOR_DATA_URI },
  }).png().toBuffer();
}

// ── OPF / nav / cover xhtml builders ─────────────────────────────────────────

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildOpf(chapterManifest, imageManifest) {
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
    <item id="nav"          href="nav.xhtml"         media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover"        href="cover.xhtml"       media-type="application/xhtml+xml"/>
    <item id="cover-image"  href="Images/cover.png"  media-type="image/png" properties="cover-image"/>
    ${imageManifest}
    ${chapterManifest}
  </manifest>
  <spine>
    <itemref idref="cover"/>
    ${chapterManifest.split('\n').filter((l) => l.includes('id="ch')).map((l) => l.match(/id="([^"]+)"/)[1]).map((id) => `    <itemref idref="${id}"/>`).join('\n')}
  </spine>
</package>
`;
}

function buildNav(chapters) {
  const items = chapters
    .map((ch) => `      <li><a href="Text/${ch.filename}">${escapeXml(ch.title)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="vi">
<head><meta charset="utf-8"/><title>${escapeXml(TITLE)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Mục lục</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

function buildCoverXhtml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="vi">
<head><meta charset="utf-8"/><title>Bìa</title></head>
<body class="cover-page" epub:type="frontmatter cover">
  <section epub:type="cover">
    <img src="Images/cover.png" alt="Bìa sách"/>
  </section>
</body>
</html>
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

// ── Chapter content ──────────────────────────────────────────────────────────

const CH1_BODY = `
<p>Chương một kể về một buổi sáng mùa thu tĩnh lặng. Sương sớm còn
phủ trên mái ngói, tiếng gà gáy vang lên từ phía xa xa. Nhân vật chính
của chúng ta — một thiếu niên mồ côi — đang ngồi bên bậu cửa, mắt
nhìn xa xăm về phía chân trời.</p>

<p>Hắn không biết rằng ngày hôm nay sẽ thay đổi cuộc đời hắn mãi mãi.
Một lá thư được gửi đến từ một ngôi trường xa xôi — ngôi trường mà
theo lời đồn, chỉ có những thiên tài mới được nhận vào.</p>

<p>Trên bàn, một chiếc hộp gỗ nhỏ vẫn còn đóng kín. Hắn đã tìm thấy
nó dưới gầm giường từ khi mới lên ba, nhưng chưa bao giờ mở ra. Hôm
nay có lẽ là lúc thích hợp nhất. Hắn cầm chiếc hộp lên, lật qua lật
lại, rồi nhẹ nhàng mở nắp.</p>

<p>Bên trong không có gì ngoài một mảnh giấy cũ kỹ, trên đó viết vài
dòng chữ mà hắn không đọc được. Hắn gấp mảnh giấy lại, cất vào túi
áo, rồi đứng dậy bước ra ngoài. Con đường làng vắng lặng, chỉ có tiếng
bước chân của hắn vang vọng.</p>

<p>Câu chuyện bắt đầu từ đây. Còn rất nhiều điều đang chờ đợi phía
trước, nhưng trước hết hắn phải vượt qua được con dốc nhỏ ở cuối
làng. Và rồi, phía sau con dốc ấy, cả thế giới mở ra.</p>
`.trim();

const CH2_BODY = `
<p>Chương hai mở ra với khung cảnh ngôi trường cổ kính nằm giữa rừng
sâu. Tòa nhà chính có ba tầng, mái ngói xanh xám, tường vàng đã bạc
màu theo thời gian. Một hàng cây bách xù cao vút bao quanh khuôn
viên, tạo nên bức tranh vừa uy nghiêm vừa thân thuộc.</p>

<p>Đây là khung cảnh mà thiếu niên của chúng ta đã mơ ước bấy lâu nay:
<img src="../Images/figure-1.png" alt="Khung cảnh ngôi trường cổ kính giữa rừng sâu với mái ngói xanh và tường vàng" />
một nơi mà hắn có thể học hỏi, rèn luyện, và tìm lại ý nghĩa của cuộc
đời mình. Hắn bước qua cổng trường, nơi có một tấm biển đá lớn khắc
bốn chữ "Tu Luyện Tâm Hồn".</p>

<p>Đón tiếp hắn là một vị sư phụ lớn tuổi, râu tóc bạc phơ, ánh mắt
hiền từ nhưng sâu thẳm. Vị sư phụ đặt tay lên vai hắn, nhẹ nhàng
nói: "Con đã đến đúng nơi rồi. Từ nay, nơi đây sẽ là nhà của con."</p>
`.trim();

const CH3_BODY = `
<p>Chương ba kể về buổi học đầu tiên. Thiếu niên ngồi giữa sân luyện,
xung quanh là hàng chục đệ tử khác cùng trang lứa. Tất cả đều mặc
đồng phục xanh lam, tóc búi cao gọn gàng.</p>

<figure>
  <img src="../Images/figure-2.png" alt="Buổi luyện tập đầu tiên với hàng chục đệ tử đứng thành vòng tròn" />
  <figcaption>Buổi luyện tập đầu tiên.</figcaption>
</figure>

<p>Vị sư phụ đứng giữa sân, giọng trầm ổn: "Hôm nay ta sẽ dạy các
con bài học đầu tiên — bài học về hơi thở. Hãy hít vào thật sâu,
giữ hơi thở trong ba nhịp, rồi thở ra thật chậm."</p>

<p>Thiếu niên nhắm mắt lại, tập trung toàn bộ tâm trí vào hơi thở
của mình. Cảm giác lạ lẫm nhưng cũng rất quen thuộc, như thể hắn đã
biết điều này từ rất lâu rồi mà quên mất. Từng nhịp thở đưa hắn đi
sâu hơn vào chính mình.</p>
`.trim();

const CH4_BODY = `
<p>Chương bốn kết thúc bằng một buổi tối yên tĩnh. Mọi người đã về
phòng nghỉ, chỉ còn thiếu niên ngồi một mình trên hành lang, ngắm
trăng. Đây là đêm đầu tiên của hắn ở nơi xa lạ, nhưng hắn không
cảm thấy cô đơn. Trái lại, lòng hắn tràn đầy hy vọng.</p>
`.trim();

// ── Chapter builders ─────────────────────────────────────────────────────────

function buildChapterXhtml({ id, title, body, dataUriPngBase64 }) {
  // If a dataUriPngBase64 is provided, splice a data: URI image into the
  // second paragraph of the body. We do this in a post-processing step
  // so the body strings stay human-readable above.
  let html = body;
  if (dataUriPngBase64) {
    const dataUriImg = `<img src="data:image/png;base64,${dataUriPngBase64}" alt="Biểu tượng nhỏ của học viện"/>`;
    // Insert after the first <p>...</p> block
    html = html.replace(/(<\/p>)/, `$1\n<p>${dataUriImg}</p>`, 1);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="vi">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title></head>
<body>
  <section epub:type="chapter">
    <h1>${escapeXml(title)}</h1>
${html}
  </section>
</body>
</html>
`;
}

// ── Main build ──────────────────────────────────────────────────────────────

async function main() {
  // 1. Generate the images.
  const coverPng = await generatePng('BÌA', COLOR_COVER_BG, COLOR_COVER_FG, 600, 900);
  const figure1Png = await generatePng('Hình 1', COLOR_FIGURE_1, COLOR_COVER_FG, 300, 200);
  const figure2Png = await generatePng('Hình 2', COLOR_FIGURE_2, COLOR_COVER_FG, 300, 200);
  const dataUriPng = await generateDataUriPng();
  const dataUriPngBase64 = dataUriPng.toString('base64');

  // 2. Build chapter XHTML. Chapter 2 has the data-URI image spliced in.
  const chapters = [
    { id: 'ch1', title: 'Chương 1: Buổi sáng mùa thu',     filename: 'ch1.xhtml', body: CH1_BODY, dataUri: false },
    { id: 'ch2', title: 'Chương 2: Ngôi trường cổ kính',    filename: 'ch2.xhtml', body: CH2_BODY, dataUri: true  },
    { id: 'ch3', title: 'Chương 3: Buổi học đầu tiên',      filename: 'ch3.xhtml', body: CH3_BODY, dataUri: false },
    { id: 'ch4', title: 'Chương 4: Đêm trăng đầu tiên',     filename: 'ch4.xhtml', body: CH4_BODY, dataUri: false },
  ];
  const chapterXhtml = {};
  for (const ch of chapters) {
    chapterXhtml[ch.filename] = buildChapterXhtml({
      id: ch.id,
      title: ch.title,
      body: ch.body,
      dataUriPngBase64: ch.dataUri ? dataUriPngBase64 : undefined,
    });
  }

  // 3. Build OPF + nav + cover + container XML.
  const chapterManifest = chapters
    .map((ch) => `    <item id="${ch.id}" href="Text/${ch.filename}" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const imageManifest = [
    `    <item id="fig-1" href="Images/figure-1.png" media-type="image/png"/>`,
    `    <item id="fig-2" href="Images/figure-2.png" media-type="image/png"/>`,
  ].join('\n');
  const opf = buildOpf(chapterManifest, imageManifest);
  const nav = buildNav(chapters);
  const coverXhtml = buildCoverXhtml();
  const containerXml = buildContainerXml();

  // 4. Assemble the ZIP. Order matters: mimetype must be the FIRST
  //    entry, uncompressed.
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', { compress: false });
  zip.addBuffer(Buffer.from(containerXml, 'utf8'), 'META-INF/container.xml');
  zip.addBuffer(Buffer.from(opf, 'utf8'),         'OEBPS/content.opf');
  zip.addBuffer(Buffer.from(nav, 'utf8'),         'OEBPS/nav.xhtml');
  zip.addBuffer(Buffer.from(coverXhtml, 'utf8'),  'OEBPS/cover.xhtml');
  for (const ch of chapters) {
    zip.addBuffer(Buffer.from(chapterXhtml[ch.filename], 'utf8'), `OEBPS/Text/${ch.filename}`);
  }
  zip.addBuffer(coverPng,   'OEBPS/Images/cover.png');
  zip.addBuffer(figure1Png, 'OEBPS/Images/figure-1.png');
  zip.addBuffer(figure2Png, 'OEBPS/Images/figure-2.png');

  zip.end();

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  const bytes = await new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });

  writeFileSync(OUTPUT_PATH, bytes);

  // 5. SHA256 sidecar — written AFTER the EPUB so the hash matches.
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(SHA_PATH, `${sha}  ${path.basename(OUTPUT_PATH)}\n`);

  // 6. Report.
  const kb = (bytes.length / 1024).toFixed(1);
  console.log(`✓ Wrote ${OUTPUT_PATH} (${kb} KB, ${bytes.length} bytes)`);
  console.log(`  SHA256: ${sha}`);
  console.log(`  Sidecar: ${SHA_PATH}`);
  console.log(`  Entries: mimetype, META-INF/container.xml, OEBPS/{content.opf, nav.xhtml, cover.xhtml,`);
  console.log(`           Text/{ch1..ch4.xhtml}, Images/{cover.png, figure-1.png, figure-2.png}}`);
  console.log(`  Data URI image embedded in: ${chapters.find((c) => c.dataUri).filename}`);
}

main().catch((err) => {
  console.error('Failed to build fixture EPUB:', err);
  process.exit(1);
});
