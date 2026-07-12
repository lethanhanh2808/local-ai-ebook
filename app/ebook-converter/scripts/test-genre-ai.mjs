const KEY = '68a569ecfa66fc00f241bc9e789c3b2808702f7b8eff6e97';
const URL = 'http://localhost:8080/v1/chat/completions';
const MODEL = 'MLX-Qwen3.5-9B-DeepSeek-V4-Flash-4bit';

const cases = [
  { title: 'Thành Tựu Tiên Đế, Toàn Bộ Nhờ Địch Nhân Cố Gắng', author: 'Mộc Xuân', description: 'Một nhân vật tu luyện thành tiên đế nhờ sự cố gắng của kẻ thù, tu tiên, huyền huyễn' },
  { title: 'Hoàng Tộc Tổ Địa Bật Hack 20 Năm: Ta Cử Thế Vô Địch', author: 'Lão Vương Trảo Tiểu Kê', description: 'Bị giam ở tổ địa hoàng tộc 20 năm, sau khi ra ngoài tu luyện thành vô địch' },
  { title: 'Bắt Đầu 100 Triệu Năm Tu Vi', author: 'Đạo Như Thị', description: 'Bắt đầu với 100 triệu năm tu vi, hệ thống tu tiên' },
  { title: 'Ta Có Thần Cấp Sửa Chữa Khí', author: 'Vân Phật', description: 'Sửa chữa khí hệ thống tu luyện, nâng cấp thành thần cấp' },
  { title: 'Chiếm Đoạt Vợ Yêu', author: 'Tiểu Ngôn', description: 'Ngôn tình, nam chính lạnh lùng chiếm đoạt nữ chính' },
];

const SYSTEM = `Bạn là chuyên gia thiết kế bìa sách Việt Nam. Bạn sẽ được cho tên + tác giả + mô tả ngắn, và phải tạo concept cho bìa.

Trả lời JSON với schema:
- imagePrompt (string tiếng Anh, 80-150 từ) — mô tả cảnh sẽ vẽ. PHẢI bao gồm:
  * Bối cảnh cụ thể (kiến trúc, phong cảnh, địa điểm)
  * Yếu tố đặc trưng của thể loại (kiếm tu, cung điện, đô thị, cặp đôi, ...)
  * Mood/không khí (dramatic, peaceful, mysterious, epic, romantic, ...)
  * Phong cách nghệ thuật ("cinematic photo", "oil painting", "watercolor", "digital painting", "ink wash with color accents", ...)
  * Bảng màu phù hợp thể loại (jade green, gold, cool blue, warm sepia, ...)
- tagline (string) — phụ đề tiếng Việt 1-6 từ
- style (enum) — ink | watercolor | painting | cinematic | sketch
- accent (string hex) — màu nhấn
- textColor (string hex) — màu chữ
- background (enum dark | light)`;

for (const b of cases) {
  console.log(`\n========== "${b.title}" ==========`);
  const userMsg = `Sách: "${b.title}" — ${b.author}
${b.description ? `Mô tả: ${b.description}` : ''}

JSON concept:`;
  try {
    const resp = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
        temperature: 0.7,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });
    if (!resp.ok) { console.log('  HTTP error:', resp.status); continue; }
    const j = await resp.json();
    const content = j?.choices?.[0]?.message?.content ?? '';
    console.log(content);
  } catch (e) { console.log('  Error:', e.message); }
}
