# tests/test_conversation_state.py
#
# Phase B.1 of D3 (BACKLOG-9) — conversation-state machine primitives.
#
# Pins:
#   - decay_active_characters: per-paragraph score decay with floor + drop
#   - touch_active: per-name score bump with 1.8 cap
#   - reset_scene: scene-id increment + clear of all scene-dependent state
#   - should_start_new_scene: heuristic scene-break detection
#   - snapshot_state: top-N active by score, capped dialogue history
#   - apply_seed_to_state: D1 hydration with score reset for active chars
#   - ConversationStateSnapshot: JSON round-trip parity with JS shape
#
# Run: python3 -m unittest tests.test_conversation_state -v

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

from conversation_attribution import (  # noqa: E402
    SCORE_DECAY,
    SCORE_FLOOR,
    SNAPSHOT_ACTIVE_CAP,
    SNAPSHOT_HISTORY_CAP,
    ActiveCharacter,
    ConversationState,
    ConversationStateSnapshot,
    DialogueTurn,
    apply_seed_to_state,
    create_conversation_state,
    decay_active_characters,
    empty_state_snapshot,
    reset_scene,
    should_start_new_scene,
    snapshot_state,
    touch_active,
)


class TestDecayActive(unittest.TestCase):
    """Pins decay rate + floor + drop-below-floor behaviour."""

    def test_decay_multiplies_score(self):
        state = create_conversation_state()
        state.active_characters["Y Đằng Long"] = ActiveCharacter(
            score=1.0, last_mention_paragraph=0, spoken_count=2,
        )
        decay_active_characters(state)
        self.assertAlmostEqual(
            state.active_characters["Y Đằng Long"].score,
            1.0 * SCORE_DECAY,
            places=6,
        )

    def test_decay_floor_drops_below_floor(self):
        state = create_conversation_state()
        # Score below SCORE_DECAY * SCORE_FLOOR will drop on first decay.
        state.active_characters["Ephemeral"] = ActiveCharacter(
            score=0.13, last_mention_paragraph=0, spoken_count=0,
        )
        # After decay: 0.13 * 0.88 = 0.1144 < SCORE_FLOOR (0.12).  Wait,
        # actually 0.1144 < 0.12 — so it should drop.
        decay_active_characters(state)
        self.assertNotIn("Ephemeral", state.active_characters)

    def test_decay_keeps_above_floor(self):
        state = create_conversation_state()
        # Score that decays to just above floor.
        state.active_characters["Stable"] = ActiveCharacter(
            score=0.30, last_mention_paragraph=0, spoken_count=0,
        )
        decay_active_characters(state)
        # 0.30 * 0.88 = 0.264 > 0.12 — kept.
        self.assertIn("Stable", state.active_characters)
        self.assertAlmostEqual(
            state.active_characters["Stable"].score,
            0.30 * SCORE_DECAY,
            places=6,
        )

    def test_decay_handles_empty_state(self):
        state = create_conversation_state()
        # No characters — should not raise.
        decay_active_characters(state)
        self.assertEqual(state.active_characters, {})


class TestTouchActive(unittest.TestCase):
    """Pins per-name score bumping + 1.8 cap."""

    def test_touch_new_character(self):
        state = create_conversation_state()
        touch_active(state, "Y Đằng Long", paragraph_index=5, amount=0.28)
        self.assertIn("Y Đằng Long", state.active_characters)
        ac = state.active_characters["Y Đằng Long"]
        self.assertAlmostEqual(ac.score, 0.28, places=6)
        self.assertEqual(ac.last_mention_paragraph, 5)
        self.assertEqual(ac.spoken_count, 0)

    def test_touch_existing_character(self):
        state = create_conversation_state()
        state.active_characters["Ưu Nhi"] = ActiveCharacter(
            score=0.5, last_mention_paragraph=0, spoken_count=1,
        )
        touch_active(state, "Ưu Nhi", paragraph_index=3, amount=0.28)
        ac = state.active_characters["Ưu Nhi"]
        self.assertAlmostEqual(ac.score, 0.78, places=6)
        self.assertEqual(ac.last_mention_paragraph, 3)
        # spoken_count is NOT touched here — only `attribute_chapter`
        # bumps it when a character becomes the speaker.
        self.assertEqual(ac.spoken_count, 1)

    def test_touch_caps_at_1_8(self):
        state = create_conversation_state()
        state.active_characters["Captain"] = ActiveCharacter(
            score=1.7, last_mention_paragraph=0, spoken_count=10,
        )
        touch_active(state, "Captain", paragraph_index=5, amount=0.5)
        ac = state.active_characters["Captain"]
        # 1.7 + 0.5 = 2.2 — capped at 1.8.
        self.assertAlmostEqual(ac.score, 1.8, places=6)

    def test_touch_none_name_is_noop(self):
        state = create_conversation_state()
        touch_active(state, None, paragraph_index=0, amount=0.28)
        touch_active(state, "", paragraph_index=0, amount=0.28)
        self.assertEqual(state.active_characters, {})


class TestResetScene(unittest.TestCase):
    """Pins scene-id increment + selective clear."""

    def test_reset_scene_increments_scene_id(self):
        state = create_conversation_state()
        state.scene_id = 3
        reset_scene(state)
        self.assertEqual(state.scene_id, 4)

    def test_reset_scene_clears_speaker_state(self):
        state = create_conversation_state()
        state.current_speaker = "Y Đằng Long"
        state.previous_speaker = "Ưu Nhi"
        state.current_focus_character = "Đằng Long"
        state.last_action_character = "Y Đằng Long"
        state.last_subject = "Ưu Nhi"
        state.last_object = "Đằng Long"
        state.last_recipient = "Y Đằng Long"
        state.last_mentioned_characters = ["Y Đằng Long", "Ưu Nhi"]
        state.dialogue_history = [DialogueTurn(0, "Y Đằng Long")]
        state.paragraphs_since_dialogue = 3
        state.active_characters["Y Đằng Long"] = ActiveCharacter(
            score=1.0, last_mention_paragraph=0, spoken_count=1,
        )
        reset_scene(state)
        self.assertIsNone(state.current_speaker)
        self.assertIsNone(state.previous_speaker)
        self.assertIsNone(state.current_focus_character)
        self.assertIsNone(state.last_action_character)
        self.assertIsNone(state.last_subject)
        self.assertIsNone(state.last_object)
        self.assertIsNone(state.last_recipient)
        self.assertEqual(state.last_mentioned_characters, [])
        self.assertEqual(state.dialogue_history, [])
        self.assertEqual(state.paragraphs_since_dialogue, 0)
        self.assertEqual(state.active_characters, {})


class TestShouldStartNewScene(unittest.TestCase):
    """Pins the scene-break heuristic."""

    def test_first_paragraph_never_starts_scene(self):
        state = create_conversation_state()
        # paragraph_index=0 → should_start_new_scene ignores long text.
        long_text = "a" * 1000
        self.assertFalse(
            should_start_new_scene(0, long_text, has_quote=False, state=state),
        )

    def test_paragraph_with_quote_never_starts_scene(self):
        state = create_conversation_state()
        # Has quote → no scene break.
        long_text = "a" * 1000
        self.assertFalse(
            should_start_new_scene(5, long_text, has_quote=True, state=state),
        )

    def test_very_long_narration_starts_scene(self):
        state = create_conversation_state()
        # paragraph_index must be > 0 — fake it by bumping paragraphs_since_dialogue.
        state.paragraphs_since_dialogue = 5
        text = "a" * 1000  # > 950 chars
        self.assertTrue(
            should_start_new_scene(5, text, has_quote=False, state=state),
        )

    def test_long_narration_after_quiet_stretch_starts_scene(self):
        state = create_conversation_state()
        state.paragraphs_since_dialogue = 5  # >= 4
        text = "a" * 700  # > 650
        self.assertTrue(
            should_start_new_scene(5, text, has_quote=False, state=state),
        )

    def test_short_narration_no_scene_break(self):
        state = create_conversation_state()
        state.paragraphs_since_dialogue = 5
        text = "Anh ta đi."  # < 650 chars
        self.assertFalse(
            should_start_new_scene(5, text, has_quote=False, state=state),
        )

    def test_scene_transition_phrase_starts_scene(self):
        state = create_conversation_state()
        state.paragraphs_since_dialogue = 5
        self.assertTrue(should_start_new_scene(
            5, "Hôm sau, anh ta thức dậy.", has_quote=False, state=state,
        ))
        self.assertTrue(should_start_new_scene(
            5, "Trong khi đó, Ưu Nhi ngồi một mình.",
            has_quote=False, state=state,
        ))

    def test_empty_text_no_scene_break(self):
        state = create_conversation_state()
        self.assertFalse(
            should_start_new_scene(5, "", has_quote=False, state=state),
        )
        self.assertFalse(
            should_start_new_scene(5, "   ", has_quote=False, state=state),
        )


class TestSnapshotState(unittest.TestCase):
    """Pins the persistable snapshot shape."""

    def test_snapshot_top_n_active_by_score(self):
        state = create_conversation_state()
        # 8 characters; only top 6 (by score) should be in the snapshot.
        for i, score in enumerate([0.1, 0.9, 0.5, 0.3, 0.8, 0.2, 0.4, 0.7]):
            name = f"Char{i}"
            state.active_characters[name] = ActiveCharacter(
                score=score, last_mention_paragraph=0, spoken_count=0,
            )
        snap = snapshot_state(state)
        self.assertEqual(len(snap.activeCharacters), SNAPSHOT_ACTIVE_CAP)
        # Top 6 by score: 0.9, 0.8, 0.7, 0.5, 0.4, 0.3 — but Char0 (0.1) and Char5 (0.2)
        # should be excluded.
        self.assertNotIn("Char0", snap.activeCharacters)
        self.assertNotIn("Char5", snap.activeCharacters)
        # First entry should be the highest scorer.
        self.assertEqual(snap.activeCharacters[0], "Char1")  # 0.9

    def test_snapshot_caps_dialogue_history(self):
        state = create_conversation_state()
        state.dialogue_history = [
            DialogueTurn(paragraph_index=i, speaker=f"Speaker{i}")
            for i in range(20)
        ]
        snap = snapshot_state(state)
        self.assertEqual(len(snap.dialogueHistory), SNAPSHOT_HISTORY_CAP)
        # Should be the LAST 6 (most recent turns).
        self.assertEqual(snap.dialogueHistory[0]["paragraphIndex"], 14)
        self.assertEqual(snap.dialogueHistory[-1]["paragraphIndex"], 19)

    def test_snapshot_includes_pure_values(self):
        state = create_conversation_state()
        state.scene_id = 5
        state.current_speaker = "Y Đằng Long"
        state.previous_speaker = "Ưu Nhi"
        state.current_focus_character = "Đằng Long"
        state.last_action_character = "Y Đằng Long"
        state.last_mentioned_characters = ["Y Đằng Long", "Ưu Nhi"]
        snap = snapshot_state(state)
        self.assertEqual(snap.sceneId, 5)
        self.assertEqual(snap.currentSpeaker, "Y Đằng Long")
        self.assertEqual(snap.previousSpeaker, "Ưu Nhi")
        self.assertEqual(snap.currentFocusCharacter, "Đằng Long")
        self.assertEqual(snap.lastActionCharacter, "Y Đằng Long")
        self.assertEqual(snap.lastMentionedCharacters, ["Y Đằng Long", "Ưu Nhi"])

    def test_snapshot_empty_state(self):
        state = create_conversation_state()
        snap = snapshot_state(state)
        self.assertEqual(snap.sceneId, 0)
        self.assertEqual(snap.activeCharacters, [])
        self.assertEqual(snap.dialogueHistory, [])
        self.assertIsNone(snap.currentSpeaker)

    def test_snapshot_json_round_trip(self):
        """Pins the JSON wire format the JS side consumes."""
        state = create_conversation_state()
        state.scene_id = 3
        state.active_characters["Y Đằng Long"] = ActiveCharacter(
            score=1.0, last_mention_paragraph=5, spoken_count=2,
        )
        state.current_speaker = "Y Đằng Long"
        state.dialogue_history = [DialogueTurn(paragraph_index=4, speaker="Ưu Nhi")]
        snap = snapshot_state(state)
        json_dict = snap.to_json_dict()
        # JS interface field names — these MUST match exactly so the
        # Next.js side can deserialize without translation.
        self.assertIn("sceneId", json_dict)
        self.assertIn("activeCharacters", json_dict)
        self.assertIn("currentSpeaker", json_dict)
        self.assertIn("previousSpeaker", json_dict)
        self.assertIn("currentFocusCharacter", json_dict)
        self.assertIn("lastActionCharacter", json_dict)
        self.assertIn("lastMentionedCharacters", json_dict)
        self.assertIn("dialogueHistory", json_dict)
        # Round-trip via from_json_dict.
        restored = ConversationStateSnapshot.from_json_dict(json_dict)
        self.assertEqual(restored.sceneId, snap.sceneId)
        self.assertEqual(restored.activeCharacters, snap.activeCharacters)
        self.assertEqual(restored.currentSpeaker, snap.currentSpeaker)
        self.assertEqual(restored.dialogueHistory, snap.dialogueHistory)


class TestApplySeedToState(unittest.TestCase):
    """Pins D1 hydration."""

    def test_apply_seed_none_is_noop(self):
        state = create_conversation_state()
        # Mark state to verify it's untouched.
        state.current_speaker = "Preexisting"
        apply_seed_to_state(state, None)
        self.assertEqual(state.current_speaker, "Preexisting")

    def test_apply_seed_hydrates_pure_values(self):
        state = create_conversation_state()
        seed = ConversationStateSnapshot(
            sceneId=7,
            activeCharacters=["Y Đằng Long"],
            currentSpeaker="Y Đằng Long",
            previousSpeaker="Ưu Nhi",
            currentFocusCharacter="Đằng Long",
            lastActionCharacter="Y Đằng Long",
            lastMentionedCharacters=["Y Đằng Long", "Ưu Nhi"],
            dialogueHistory=[{"paragraphIndex": 12, "speaker": "Y Đằng Long"}],
        )
        apply_seed_to_state(state, seed)
        self.assertEqual(state.scene_id, 7)
        self.assertEqual(state.current_speaker, "Y Đằng Long")
        self.assertEqual(state.previous_speaker, "Ưu Nhi")
        self.assertEqual(state.current_focus_character, "Đằng Long")
        self.assertEqual(state.last_action_character, "Y Đằng Long")
        self.assertEqual(state.last_mentioned_characters, ["Y Đằng Long", "Ưu Nhi"])
        self.assertEqual(len(state.dialogue_history), 1)
        self.assertEqual(state.dialogue_history[0].speaker, "Y Đằng Long")
        self.assertEqual(state.dialogue_history[0].paragraph_index, 12)

    def test_apply_seed_resets_active_scores(self):
        """D1 contract: seed-time scores start at 0.5 so the presence-
        scoring layer still contributes on the new chapter's early
        paragraphs.  Position/spoken-count are NOT carried over."""
        state = create_conversation_state()
        seed = ConversationStateSnapshot(
            sceneId=2,
            activeCharacters=["Y Đằng Long", "Ưu Nhi"],
            currentSpeaker="Y Đằng Long",
            previousSpeaker=None,
            currentFocusCharacter=None,
            lastActionCharacter=None,
            lastMentionedCharacters=[],
            dialogueHistory=[],
        )
        apply_seed_to_state(state, seed)
        for name in ["Y Đằng Long", "Ưu Nhi"]:
            ac = state.active_characters[name]
            self.assertAlmostEqual(ac.score, 0.5, places=6)
            self.assertEqual(ac.last_mention_paragraph, -1)
            self.assertEqual(ac.spoken_count, 0)

    def test_apply_seed_deep_copies_arrays(self):
        """Subsequent mutation on `state.dialogue_history` must not
        bleed back into the seed."""
        state = create_conversation_state()
        seed = ConversationStateSnapshot(
            sceneId=1, activeCharacters=[], currentSpeaker=None,
            previousSpeaker=None, currentFocusCharacter=None,
            lastActionCharacter=None, lastMentionedCharacters=["A", "B"],
            dialogueHistory=[{"paragraphIndex": 0, "speaker": "A"}],
        )
        apply_seed_to_state(state, seed)
        # Mutate state.
        state.dialogue_history.append(DialogueTurn(1, "C"))
        state.last_mentioned_characters.append("D")
        # Seed must be unaffected.
        self.assertEqual(len(seed.dialogueHistory), 1)
        self.assertEqual(seed.lastMentionedCharacters, ["A", "B"])

    def test_apply_seed_resets_scene_counters(self):
        """last_subject/last_object/last_recipient/paragraphs_since_dialogue
        are intentionally reset on seed — they'll be rebuilt by the new
        chapter's mention passes."""
        state = create_conversation_state()
        state.last_subject = "stale_subject"
        state.last_object = "stale_object"
        state.last_recipient = "stale_recipient"
        state.paragraphs_since_dialogue = 7
        apply_seed_to_state(state, ConversationStateSnapshot(
            sceneId=1, activeCharacters=[], currentSpeaker=None,
            previousSpeaker=None, currentFocusCharacter=None,
            lastActionCharacter=None, lastMentionedCharacters=[],
            dialogueHistory=[],
        ))
        self.assertIsNone(state.last_subject)
        self.assertIsNone(state.last_object)
        self.assertIsNone(state.last_recipient)
        self.assertEqual(state.paragraphs_since_dialogue, 0)


class TestEmptyStateSnapshot(unittest.TestCase):
    """Pins the no-characters early-return snapshot."""

    def test_empty_snapshot_all_none_or_empty(self):
        snap = empty_state_snapshot()
        self.assertEqual(snap.sceneId, 0)
        self.assertEqual(snap.activeCharacters, [])
        self.assertIsNone(snap.currentSpeaker)
        self.assertIsNone(snap.previousSpeaker)
        self.assertIsNone(snap.currentFocusCharacter)
        self.assertIsNone(snap.lastActionCharacter)
        self.assertEqual(snap.lastMentionedCharacters, [])
        self.assertEqual(snap.dialogueHistory, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)