# tests/test_attribution_engine_toggle.py
#
# D3 Phase D — ATTRIBUTION_ENGINE env toggle pins.
#
# Pins:
#   - Default value is 'conversation_v3' (matches D3 acceptance decision)
#   - Explicit 'legacy' value is honoured
#   - Unknown values fall back to 'conversation_v3' with a stderr warning
#   - When set to 'legacy', Tier 3b (vncorenlp + conversation_attribution
#     port) is skipped in split_into_segments → only the regex path runs
#   - When set to 'conversation_v3', Tier 3b runs as before
#
# Run: python3 -m unittest tests.test_attribution_engine_toggle -v

from __future__ import annotations

import importlib
import io
import os
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))


def _reload_audiobook_generator(env_value: str | None):
    """Reload `audiobook_generator` with the given ATTRIBUTION_ENGINE env var.

    Returns the reloaded module so tests can introspect ATTRIBUTION_ENGINE.
    """
    if env_value is None:
        os.environ.pop("ATTRIBUTION_ENGINE", None)
    else:
        os.environ["ATTRIBUTION_ENGINE"] = env_value

    # Drop cached module to force re-evaluation of the toggle at import time.
    sys.modules.pop("audiobook_generator", None)
    return importlib.import_module("audiobook_generator")


class TestAttributionEngineToggle(unittest.TestCase):
    """Pins the env-toggle defaults + value validation."""

    def test_default_is_conversation_v3(self):
        # No env var set → must default to the new engine.
        ag = _reload_audiobook_generator(None)
        self.assertEqual(ag.ATTRIBUTION_ENGINE, "conversation_v3")

    def test_legacy_value_honoured(self):
        ag = _reload_audiobook_generator("legacy")
        self.assertEqual(ag.ATTRIBUTION_ENGINE, "legacy")

    def test_conversation_v3_value_honoured(self):
        ag = _reload_audiobook_generator("conversation_v3")
        self.assertEqual(ag.ATTRIBUTION_ENGINE, "conversation_v3")

    def test_case_insensitive(self):
        ag = _reload_audiobook_generator("LEGACY")
        self.assertEqual(ag.ATTRIBUTION_ENGINE, "legacy")

    def test_unknown_value_falls_back(self):
        buf = io.StringIO()
        with redirect_stderr(buf):
            ag = _reload_audiobook_generator("conversation-v9-experimental")
        self.assertEqual(ag.ATTRIBUTION_ENGINE, "conversation_v3")
        self.assertIn("unknown ATTRIBUTION_ENGINE", buf.getvalue())

    def test_active_engine_logged_at_import(self):
        buf = io.StringIO()
        with redirect_stderr(buf):
            _reload_audiobook_generator("legacy")
        # The "[attribution_engine] active=..." log line should appear at
        # import so operators can see the active engine in service logs.
        self.assertIn("[attribution_engine]", buf.getvalue())
        self.assertIn("active=legacy", buf.getvalue())


class TestAttributionEngineBranching(unittest.TestCase):
    """Pins the Tier 3b gating in `split_into_segments`.

    Tier 3b is the entrypoint for the new ported engine
    (`vncorenlp_attribution.attribute_chapter` + `conversation_attribution`'s
    `attribute_chapter` consumer).  When `ATTRIBUTION_ENGINE=legacy`, the
    Tier 3b call must be skipped so the engine does not contribute
    evidence; when set to `conversation_v3`, it must run.
    """

    def _reload(self, value: str):
        return _reload_audiobook_generator(value)

    def _html(self) -> str:
        return (
            '<html><body><p>Y Đằng Long nói: "Xin chào."</p></body></html>'
        )

    def _cmap(self) -> dict:
        return {
            "characters": [
                {"name": "Y Đằng Long", "aliases": ["Đằng Long"], "gender": "male"},
            ],
            "voices_by_id": {},
            "voices_by_name": {},
            "default_voice_id": None,
            "default_voice_name": None,
        }

    def test_legacy_skips_tier3b(self):
        """ATTRIBUTION_ENGINE=legacy → _tier3b.attribute_chapter not called."""
        ag = self._reload("legacy")
        # Force a re-import so the ATTRIBUTION_ENGINE constant is the legacy
        # value (the module was reloaded above).
        with patch.object(ag, "_TIER3B_AVAILABLE", True, create=False):
            called = {"count": 0}

            def fake_tier3b(*_args, **_kwargs):
                called["count"] += 1
                return {}

            with patch.object(ag, "_tier3b", create=True) as mod:
                mod.attribute_chapter = fake_tier3b
                with patch.object(ag, "split_paragraphs_with_offsets",
                                  return_value=[]) as splits, \
                     patch.object(ag, "_regex_segment_chapter",
                                  return_value=[]) as regex:
                    ag.split_into_segments(self._html(), self._cmap())
            # In legacy mode Tier 3b is gated, so the regex path still
            # runs but paragraph_offsets stays empty (split_paragraphs
            # not called).
            splits.assert_not_called()
            regex.assert_called_once()
            self.assertEqual(called["count"], 0,
                             "Tier 3b must not run when ATTRIBUTION_ENGINE=legacy")

    def test_conversation_v3_runs_tier3b(self):
        """ATTRIBUTION_ENGINE=conversation_v3 (default) → Tier 3b runs."""
        ag = self._reload("conversation_v3")
        with patch.object(ag, "_TIER3B_AVAILABLE", True, create=False):
            called = {"count": 0}

            def fake_tier3b(*_args, **_kwargs):
                called["count"] += 1
                return {}

            with patch.object(ag, "_tier3b", create=True) as mod:
                mod.attribute_chapter = fake_tier3b
                with patch.object(ag, "split_paragraphs_with_offsets",
                                  return_value=[]), \
                     patch.object(ag, "_regex_segment_chapter",
                                  return_value=[]):
                    ag.split_into_segments(self._html(), self._cmap())
            self.assertEqual(called["count"], 1,
                             "Tier 3b must run when ATTRIBUTION_ENGINE=conversation_v3")


if __name__ == "__main__":
    unittest.main(verbosity=2)