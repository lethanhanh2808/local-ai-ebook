// src/tests/genre-detector.test.ts
//
// Verifies the Vietnamese-novel genre detector picks the right bucket
// from typical title/description signals across the major genre
// families we care about.
import { describe, expect, it } from 'vitest';
import { detectGenre } from '../lib/covers/genre-detector';

describe('detectGenre', () => {
  it('classifies tu tiểu thuyết titles correctly', () => {
    const cases = [
      'Thành Tựu Tiên Đế',
      'Hoàng Tộc Tổ Địa Bật Hack 20 Năm',
      'Bắt Đầu 100 Triệu Năm Tu Vi',
      'Phàm Nhân Tu Tiên Truyện',
      'Ta Là Tà Đế',
    ];
    for (const title of cases) {
      const d = detectGenre({ title, description: 'tu luyện, kiếm đế, huyền huyễn' });
      expect(d.genre, `expected tu_tieu_thuyet for "${title}", got ${d.genre}`).toBe('tu_tieu_thuyet');
    }
  });

  it('classifies ngôn tình titles correctly', () => {
    const cases = [
      'Chiếm Đoạt Vợ Yêu',
      'Cô Vợ Bé Nhỏ Của Tổng Tài',
      'Boss Là Vợ Tôi',
    ];
    for (const title of cases) {
      const d = detectGenre({ title, description: 'ngôn tình lãng mạn' });
      expect(d.genre, `expected ngon_tinh for "${title}", got ${d.genre}`).toBe('ngon_tinh');
    }
  });

  it('classifies game/lit-RPG titles correctly', () => {
    const d = detectGenre({
      title: 'Ta Có Thần Cấp Sửa Chữa Khí',
      description: 'hệ thống tu luyện, nâng cấp trang bị',
    });
    expect(d.genre).toBe('game_system');
  });

  it('returns "unknown" when no signal matches', () => {
    const d = detectGenre({ title: 'A Random Story About Destiny', description: '' });
    expect(d.genre).toBe('unknown');
    expect(d.confidence).toBeLessThan(0.5);
  });

  it('honours explicit genre hint', () => {
    const d = detectGenre({
      title: 'Does not matter',
      description: '',
      hint: 'ngon_tinh',
    });
    expect(d.genre).toBe('ngon_tinh');
    expect(d.confidence).toBe(1);
    expect(d.matchedKeywords).toContain('explicit-hint');
  });

  it('handles diacritics-stripped variants', () => {
    // Curl quotes and apostrophes in user-typed titles often have
    // missing diacritics — the stripped variant should still match.
    const d = detectGenre({ title: 'Bat Dau 100 Trieu Nam Tu Vi', description: '' });
    expect(d.genre).toBe('tu_tieu_thuyet');
  });

  it('maps "Ma Tộc" to tu tiểu thuyết (demon clan), not kinh dị', () => {
    const d = detectGenre({ title: 'Ma Tộc', description: 'truyện tu tiên về bộ tộc ma' });
    expect(d.genre).toBe('tu_tieu_thuyet');
  });
});
