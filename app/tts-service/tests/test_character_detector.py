from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

import character_detector as detector  # noqa: E402


class TestEpubSampling(unittest.TestCase):
    def test_parses_namespaced_opf_regardless_of_attribute_order(self):
        opf = '''<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf">
          <manifest>
            <item href='chapter%201.xhtml' media-type='application/xhtml+xml' id='c1'/>
            <item media-type='application/xhtml+xml' id='c2' href='chapter2.xhtml'/>
            <item href='chapter3.xhtml' id='c3' media-type='application/xhtml+xml'/>
          </manifest>
          <spine><itemref linear='yes' idref='c1'/><itemref idref='c2'/><itemref idref='c3'/></spine>
        </package>'''
        with tempfile.TemporaryDirectory() as tmp:
            epub = Path(tmp) / 'book.epub'
            with zipfile.ZipFile(epub, 'w') as zf:
                zf.writestr('OPS/content.opf', opf)
                zf.writestr('OPS/chapter 1.xhtml', '<p>Chương đầu &amp; mở đầu.</p>')
                zf.writestr('OPS/chapter2.xhtml', '<p>Chương giữa.</p>')
                zf.writestr('OPS/chapter3.xhtml', '<p>Chương cuối.</p>')
            rows = detector.extract_chapter_samples(str(epub), max_chapters=2, max_chars=500)
        self.assertEqual([row['id'] for row in rows], ['c1', 'c3'])
        self.assertIn('Chương đầu & mở đầu.', rows[0]['text'])
        self.assertIn('Chương cuối.', rows[1]['text'])

    def test_zero_sampling_limits_are_safe(self):
        self.assertEqual(detector.extract_chapter_samples('missing.epub', max_chapters=0), [])


class TestDetectionSanitization(unittest.TestCase):
    def test_noisy_llm_fields_do_not_abort_the_detection(self):
        payload = {
            'characters': [{
                'name': 'Lan',
                'aliases': [' Lan ', 'A Lan', 'A Lan', 12],
                'gender': 'female',
                'age': 'young',
                'tone': 'invented-tone',
                'role': 'main',
                'lines_estimate': 'many',
                'sample_lines': 'not-an-array',
            }],
            'total_dialogue_lines': 'unknown',
            'summary': 'ok',
        }
        with patch.object(detector, 'call_omlx', return_value=json.dumps(payload, ensure_ascii=False)):
            result = detector._run_detection('Lan nói: “Xin chào.”', 'test')
        char = result['characters'][0]
        self.assertEqual(char['aliases'], ['A Lan'])
        self.assertEqual(char['tone'], 'unknown')
        self.assertEqual(char['lines_estimate'], 0)
        self.assertEqual(char['sample_lines'], [])
        self.assertEqual(result['total_dialogue_lines'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
