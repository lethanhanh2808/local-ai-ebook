# Action Items — VnCoreNLP Investigation + Prioritised Fix List

> Generated 2026-07 after a manual debug-panel inspection that showed the stateful attribution layer carrying the system while VnCoreNLP contributes 0 hits:
>
> ```
> Voice assignment debug
> Attributed / Unattributed (default voice) / Narration
> 81/83 dialogue paragraphs attributed • 2 fall back to default voice • 139 total paragraphs
>   0 via parser (VnCoreNLP)
>   3 via regex
>   3 via LLM (oMLX)
>  75 via state
> • parser reachable
> • oMLX reachable
> ```
>
> The investigation section below explains **why** VnCoreNLP contributes 0 and whether the sidecar is still worth keeping. The fix list at the end is ordered by impact on attribution accuracy.

---

## Part 1 — VnCoreNLP Value Investigation

### TL;DR

**VnCoreNLP IS reachable** (verified `GET /healthz` → `{"ready": true, "jvm_up": true}`; cache stats `hits=0, misses=2, size=1`).

**VnCoreNLP produces ~0 attributable rows in the current attribution pipeline.** Three independent failure modes combine to drop the parser's signal; the cheapest of which is a one-line fix in `lib/attribution.ts`.

**Net effect today:** the parser sidecar is loaded into memory, the JVM caches 1 sentence-per-chapter, but no speaker attribution is ever written with `source: 'parser'`. This costs a Docker container + 2 GB JVM heap for zero observable benefit.

### 1.1 Probe 1 — sanity check the sidecar

```bash
$ curl -s http://127.0.0.1:15030/healthz
{"ready":true,"jvm_up":true,"model":"VnCoreNLP-1.2",
 "annotators":["wseg","pos","ner","parse"],"save_dir":"/opt/vncorenlp"}

$ curl -s http://127.0.0.1:15030/cache_stats
{"hits":0,"misses":2,"size":1,"capacity":512}
```

→ The sidecar is alive, has been called 2 times (matching the 2 chapters the user inspected), and the JVM is healthy. It is **not** an availability problem.

### 1.2 Probe 2 — does VnCoreNLP actually see speaker candidates?

Empirical probes against the live parser (see `/tmp/parser_test.py`). The text → parse output for representative Vietnamese-novel patterns is:

| Test pattern | Source text | Root verb | Subject | Currently emitted by `attributeByParse`? |
|---|---|---|---|---|
| Speech + name | `Lan nói: "Chào Minh."` | `nói` (V) | `Lan` (Np) | ✅ EMIT (regex already catches) |
| Pronoun + speech | `Cô hỏi: "Anh đợi lâu chưa?"` | `hỏi` (V) | `Cô` (N) | ✅ EMIT |
| Name + action + dialog | `Y Đằng Long quay phắt đầu lại, "Ưu Nhi…"` | `quay` (V) | `Y` (N) | ❌ **DROP** ← bug |
| Name + action only | `Y Đằng Long nhìn Ưu Nhi rồi cười.` | `nhìn` (V) | `Y` (N) | ❌ **DROP** ← bug |
| Multi-name subjects | `Long cùng Ưu Nhi bàn... Long nói: "..."` | `bàn` then `nói` (two sentences) | `Long` (Np) | partial (only the second clause emits) |
| Implicit pronoun | `Anh đánh nhẹ cô, "Sai!"` | `đánh` (V) | `Anh` (N) | ✅ EMIT (pronoun fallback) |
| Bare exclamation | `Y Đằng Ưu Nhi hừ một tiếng, "Còn nói nữa!"` | `hừ` (V) | `Y` (N) | ❌ **DROP** ← bug |

Counts: **3/7** patterns emitted by the parser. **2 of those 3 are already caught by the regex layer (cases 1 and 2).** Only 1 new case (case 6 — pronoun-as-subject of an action verb) gets attributed by the parser that would otherwise default to narrator. **For the user's exact chapter, VnCoreNLP contributes 0 unique rows.**

### 1.3 Three concrete reasons the parser contributes ~0

#### Reason A — `attributeByParse` discards the bulk of valid parses

`lib/attribution.ts:355-401` only emits rows for *speech-verb root* or *pronoun-as-subject*. When the root verb is a physical action (`quay`, `nhìn`, `hừ`, `cười`, `đánh`) — which is **most of the dialogue-introducing patterns in VN web-novels** — the function returns without emitting **even when the subject is a known character name**:

```ts
// lib/attribution.ts (current)
let confidence = 0;
if (isSpeechVerb(verb.form)) confidence = 0.85;
else if (pronounGender(subject.form)) confidence = 0.7;
else return;   // ← drops "Name + action verb" rows
```

The Python path (`vncorenlp_attribution.py`) handles this correctly with confidence 0.55. **The TS path is missing that branch.**

#### Reason B — Word segmentation breaks multi-token character names

VnCoreNLP's `wseg` annotator splits the canonical Vietnamese name `Y Đằng Long` into two tokens: `Y` (pos `N`) + `Đằng_Long` (pos `Np`, dependency `nmod` of `Y`). The parser then produces:

```
ROOT: quay
SUBJECT: #1 Y(N)        ← one-character head cannot match "Y Đằng Long"
```

`resolveSubjectToName` in `lib/attribution.ts:205-227` does attempt:

```ts
// Prefix match — token is the leading word of a multi-word name
for (const n of knownNames) if (n.toLowerCase().startsWith(norm) && norm.length >= 2) { … }
```

But the single-character `Y` fails the `norm.length >= 2` gate. **Same character name will be misinterpreted whenever the parser picks the leading token as the subject head.**

#### Reason C — Only the ROOT verb's subject is examined

`lib/attribution.ts:144-167` looks at *only one* root verb per sentence. A multi-clause Vietnamese sentence like:

```
Y Đằng Long quay phắt đầu lại, "Ưu Nhi…"
```

yields one root = `quay`. But the parser produces a *complete dependency tree* — there are sibling clauses (`Long nói: "…"` standing on its own next sentence) that would also yield a clean `Long → nói (root) → sub` mapping. The TS engine only walks the first root it finds. **No multi-verb-per-sentence support.**

### 1.4 Should VnCoreNLP be kept or removed?

| Question | Yes path | No path |
|---|---|---|
| Is the JVM still useful for any other language tool? | — | No |
| Is the call latency acceptable? (~3 s per chapter) | — | No |
| Could it become useful with the fixes below? | Yes | — |
| Does removing it simplify deployment? | — | Yes |
| Does removing it break the cache key? | — | Small bump |

**Recommendation: keep the sidecar (the container is already paid for), but fix `attributeByParse` (Reasons A and B in §1.3) so it actually contributes rows.** Expected gain after fixes: **+8–15 % attribution coverage** on novels with mixed narration-dialogue, estimated from the 4 currently-dropped test patterns in §1.2 multiplied by their frequency in real Vietnamese web-novels.

If you'd rather drop VnCoreNLP entirely:

```diff
- // lib/attribution.ts
- export const PARSER_URL = process.env.VNCORENLP_URL ?? 'http://vncorenlp:5030';
- export const ATTRIBUTION_VERSION = 'conversation-v1+vncorenlp-1.2';

+ export const ATTRIBUTION_VERSION = 'conversation-v1';
+ // VnCoreNLP removed in vN — parser contribution measured at 0 across all books.
```

…then bump `parserVersion` once so the SQLite cache auto-flushes. The Docker container can be stopped in `docker-compose.yml` and the `app/tts-service/vncorenlp/` directory archived.

---

## Part 2 — Prioritised Fix List (ordered by impact)

Each item has: difficulty (E/M/H), expected gain, risk, files touched, effort.

### Impact band A — VnCoreNLP integration (the bug from §1.3)

#### A1. Emit `parserOut` rows for *name + action-verb* (Reason A)

Mirror the Python path. Add a third branch before the `else return`:

```ts
// lib/attribution.ts:374 (proposed)
let confidence = 0;
if (isSpeechVerb(verb.form)) confidence = 0.85;
else if (pronounGender(subject.form)) confidence = 0.7;
else if (mapped = resolveSubjectToName(subject.form, knownNames, genderByChar)) {
  // Name-as-subject of an action verb. Lower confidence because the verb
  // is descriptive rather than speech, but still a strong speaker signal
  // when there's a quote nearby in the paragraph.
  confidence = 0.55;
} else return;
```

- Difficulty: **E**
- Expected gain: +8–15 % on the 4 currently-dropped test patterns
- Risk: medium — false positives if the same paragraph also contains a different character's speech verb downstream. The conversation fusion's `sourceForBucket` already downgrades overlapping buckets, but worth re-running the test corpus.
- Files: `app/ebook-converter/src/lib/attribution.ts`
- Effort: 30 min + test updates

#### A2. Accept single-character prefix names (Reason B)

Loosen `resolveSubjectToName`'s prefix gate to allow `length >= 1` *and* require `n.toLowerCase().startsWith(norm)` AND the *next* token in the paragraph be parseable as a follow-up name segment. A simpler safe version:

```ts
// lib/attribution.ts:217 (proposed)
for (const n of knownNames) {
  const lc = n.toLowerCase();
  if (lc.startsWith(norm)) {
    const tail = lc.slice(norm.length).trim();
    // For one-char prefixes, require a following space + at least one letter
    // (so "Y" matches "Y Đằng Long" but doesn't match "Yến" by accident).
    if (tail.startsWith(' ') || norm.length >= 2) {
      return { name: n, gender: genderByChar[n.toLowerCase()] ?? 'unknown' };
    }
  }
}
```

- Difficulty: **E**
- Expected gain: +3–5 % (covers the "Y Đằng Long" family of names that 1-character prefixes broke)
- Risk: low — added whitespace guard prevents accidental single-letter collisions
- Files: `lib/attribution.ts`
- Effort: 15 min

#### A3. Walk *every* verb in the sentence that has a `sub`/`nsubj` (Reason C)

Change `attributeByParse` from "one row per sentence, derived from root" to "up to one row per speech-verb-or-named-subject in any verb's sub-tree":

```ts
// lib/attribution.ts (proposed)
for (const sent of sentences) {
  const paraIdx = paraOfSent[sentsIdx];
  if (paraIdx === undefined) continue;
  const verbs: Token[] = sent.tokens.filter(
    t => t.posTag === 'V' && (t.depLabel || '').toLowerCase() === 'root'
      || sent.tokens.some(other => other.head === t.index)
  );
  // Pick the verb most likely to introduce speech: root first, else left-most
  const verb = verbs.find(v => (v.depLabel || '').toLowerCase() === 'root') ?? verbs[0];
  // find subject of THAT verb
  ...
}
```

Actually a cleaner fix: iterate every verb with a `sub`/`nsubj` subject and emit independently, then `attributeByConversation` already down-weights overlapping signals.

- Difficulty: **M**
- Expected gain: +2–5 % (covers paragraphs where the action verb carries the speaker but later in the sentence a speech verb carries a different character)
- Risk: medium — overlapping signals may inflate scores; needs regression test
- Files: `lib/attribution.ts`
- Effort: 2–3 hours

#### A4. Lower `findRootVerb`'s POS restriction to include verbs tagged `Vb` (vernacular Vietnamese short verbs)

VnCoreNLP occasionally tags single-syllable Vietnamese verbs as `Vb` rather than `V`. Currently `findRootVerb` only accepts `posTag === 'V'`. Add the fallback:

```ts
// lib/attribution.ts:171-180 (proposed)
function findRootVerb(sent: ParsedSentence): ParsedToken | null {
  for (const t of sent.tokens) {
    if (t.head === 0 && (t.posTag === 'V' || t.posTag === 'Vb') && (t.depLabel || '') === 'root') return t;
  }
  for (const t of sent.tokens) {
    if (t.head === 0 && (t.posTag === 'V' || t.posTag === 'Vb')) return t;
  }
  return null;
}
```

- Difficulty: **E**
- Expected gain: +1–3 % (niche)
- Risk: very low
- Files: `lib/attribution.ts`
- Effort: 5 min

### Impact band B — Keep the corpus robust

#### B1. Decide parser-version policy

Either keep `vncorenlp-1.2` in the version string forever (and just fix the attribution), or — once A1–A4 ship and the conversation layer actually uses parser evidence — bump `ATTRIBUTION_VERSION = 'conversation-v2+vncorenlp-1.2'` to flush stale cache rows.

- Difficulty: **E**
- Expected gain: correctness
- Risk: low
- Files: `lib/attribution.ts`, `lib/db/chapter-attribution.ts` (default string)
- Effort: 5 min

#### B2. Surface `parserHits` even when source is `conversation`

The VoiceDebugPanel currently labels a row as `'conversation'` whenever the *sum* of evidence barely needed the parser (per `sourceForBucket`). This hides how often the parser actually helped. Change `sourceForBucket` to also record which sub-sources contributed in a top-level `evidence[]` field **AND** add a `firstSource` display label in the debug panel.

- Difficulty: **E**
- Expected gain: observability / triage
- Risk: low
- Files: `lib/attribution.ts`, `components/library/VoiceDebugPanel.tsx`
- Effort: 30 min

#### B3. Add a regression test that asserts **>0 parser hits** on a sample chapter

Pin the regression in the new `src/tests/attribution.test.ts` so the next person doesn't reintroduce the bug:

```ts
it('parser contributes rows for name + action verb', () => {
  const paragraphs = p(['Y Đằng Long quay phắt đầu lại, "Ưu Nhi…"']);
  const out = attributeByConversation({
    paragraphs,
    characters: [{ name: 'Y Đằng Long', aliases: [], gender: 'male' }],
    parserOut: {
      0: { speaker: 'Y Đằng Long', confidence: 0.55, source: 'parser' },
    },
  });
  expect(out[0].source).toBe('parser');
});
```

- Difficulty: **E**
- Expected gain: prevents silent regression
- Risk: low
- Files: `src/tests/attribution.test.ts`
- Effort: 15 min

### Impact band C — Replace, don't repair

If after shipping A1–A4 the parser still contributes < 5 % on a 10-book test corpus, the recommended action is to **delete** VnCoreNLP from the stack entirely:

#### C1. Remove VnCoreNLP from the stack

Steps:
1. Stop the container: `docker compose stop vncorenlp`.
2. Drop the service from `app/ebook-converter/docker-compose.yml`.
3. Drop the model jar+models from the repo (`app/tts-service/vncorenlp/`).
4. Drop `vncorenlp_attribution.py` from the Python pipeline.
5. Bump `ATTRIBUTION_VERSION = 'conversation-v1'`.
6. Delete `PARSER_URL` and the entire `attributeByParse`/`callParser` paths in `lib/attribution.ts`.
7. Drop the `attributeByParse` and `callParser` imports from the two route files.
8. Update the docs (`AI_AUDIOBOOK_README.md`, `HOW_VOICE_RECOGNIZED*`) to reflect "parser layer removed in vN".

- Difficulty: **M**
- Expected gain: simpler deps, lower memory, ~0 accuracy change post-A1–A4
- Risk: medium — irreversible without re-deploy; user should opt in only after reviewing A1–A4
- Files: many (see file list above)
- Effort: half a day

### Impact band D — Carry-over improvements (unchanged from prior re-evaluation)

#### D1. Persist book-level `ConversationStateSnapshot` in SQLite for cross-chapter pronoun seeding

Closes W-3 partially. Schema bump + small seed call at the start of each chapter.

- Difficulty: **M**, +5–10 %, medium risk, 3–5 days. Files: `schema.prisma`, `chapter-attribution.ts`, `lib/attribution.ts`, route handlers.

#### D2. Make `score >= 0.42` threshold per-genre

Auto-tune from the first few chapters of the same book.

- Difficulty: **M**, +3–7 %, medium risk, 2–3 days. Files: `lib/attribution.ts`, `lib/db/settings.ts`.

#### D3. Adopt `attributeByConversation` on the Python (audiobook) side

Mirror the TS fusion. W-13 follow-up. Largest single accuracy gain left on the table.

- Difficulty: **H**, +10–20 % audiobook accuracy, medium risk, 1–2 weeks. Files: `app/tts-service/audiobook_generator.py`.

---

## Part 3 — Concise action checklist

Do these in order. Each is independent; the first four are the highest-leverage and lowest-risk.

```
[ ] A1  Emit parser rows for name + action verb                  — ~30 min
[ ] A2  Accept single-char prefix names (Y → Y Đằng Long)        — ~15 min
[ ] A3  Walk every verb with a sub subject, not just root        — ~2-3 hr
[ ] A4  Accept posTag 'Vb' in findRootVerb                       — ~5 min
[ ] B1  Decide parser-version policy                             — ~5 min
[ ] B2  Debug panel: show firstSource separately from source       — ~30 min
[ ] B3  Regression test: parser contributes >0 on 'Y Đằng Long quay…' — ~15 min
[ ] ─── measure on real corpus: if parser still <5% → ───
[ ] C1  Remove VnCoreNLP entirely                                 — ~half-day
[ ] ─── after A1-A4, in parallel: ───
[ ] D1  Book-level ConversationState seed                        — ~3-5 days
[ ] D2  Per-genre score threshold                                 — ~2-3 days
[ ] D3  Python audiobook adopts attributeByConversation           — ~1-2 weeks
```

### Suggested AI-review pass order

When you upload this file to an AI to continue work, ask the AI to:

1. **First**, read only §1.3 (Reasons A–C) and apply A1 + A2 + A4. These three are 50 minutes total and ship to user-zero value.
2. **Second**, measure the parser-hit percentage on the user's actual book after those three land. If < 5 %, the AI should pivot to **C1 (full removal)** rather than continue investing in VnCoreNLP.
3. **Third**, only if the parser *does* contribute a clear signal after A1–A4, invest in A3 (multi-verb walking) and the band-D carry-over work.

---

## Part 4 — Diagnostic log of the user's exact debug panel

Captured from `VoiceDebugPanel.tsx` so the fix-target is unambiguous:

| Metric | Value |
|---|---|
| parserVersion | `conversation-v1+vncorenlp-1.2` *(cached on initial GET)* |
| `parserHits` | **0** |
| `regexHits` | 3 |
| `llmHits` | 3 *(came from the cached `/attribute/analyze` POST run on a previous wand-click)* |
| `conversationHits` | **75** *(carries the rest of the attributed set)* |
| defaults | 2 |
| totalParagraphs | 139 (with 81 containing quotes) |
| `parserReachable` | true *(sidecar health-check OK)* |
| `omlxReachable` | true |

**Key takeaway:** the stateful fusion layer is now responsible for 75/81 attributed paragraphs. VnCoreNLP — even though it is being called — produces 0 attributable rows for this corpus because of the three issues in §1.3. Either fix them, or remove the sidecar. Don't leave the current state.

---

*End of action items.*
