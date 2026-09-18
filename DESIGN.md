<!--
THESIS: The ebook-converter is a private library and workshop for a small circle
of readers. Its surface is not a SaaS dashboard; it is a reference manual laid
open at the right page, with chaptered sections tabbed along the fore edge so
you can flip to the next stage of conversion without losing your place. Each
stage of the pipeline (convert → review → assign voices → generate audio) is a
chapter card you can hold in your hand.

OWN-WORLD: A boxed-software reference manual. Chrome-yellow divider boards
between sections carry no mark at all; the chrome-yellow is structural, not
ornament. Every content panel sits on a bleached-calico paper ground (warm
off-white) with one short hard shadow that reads as a die-cut acetate leaf
hinged a millimetre above the divider. Black ink for prose, chrome-yellow for
section headers and the active tab, a single hairline divider for structure.
No glassmorphism, no gradient buttons, no neon accents, no rounded corners
beyond 2-4 px (acetate edges are crisp, not pillowy).

The vertical stepped tab rail down the fore edge — the leftmost column on
dense pages — lists every chapter / pipeline stage. The active tab is filled
with chrome-yellow; inactive tabs are paper-cream with a hairline border and
ink labels in mixed case.

STORY: A reader opens their library, picks an ebook, and reads the manual:
each chapter's conversion status is a tabbed leaf; the character-bible review
is an acetate overlay that lifts when there are AI-suggested names waiting
behind a REVEAL (held = hidden, revealed = ink); failed conversions are
honest stops (a row that halts mid-step, two clipped labels meeting across a
single red seam — no apology, no modal, the row stops and you see why).

FIRST VIEWPORT: On any library page, the leftmost column is the stepped tab
rail — every chapter as a vertical card, active chapter filled chrome-yellow,
inactive paper-cream with hairline border. The centre column is the chapter
content on paper-calico ground. The rightmost column is reserved for the
character voice plan + audio status, again on paper ground, with acetate
overlays for review/assign actions.

FORM: Raised reference-manual. Two disciplines inherited from declined
challengers and named as visible raises:

  1. "HONEST STOPS" — from the depot-blind world. When a pipeline stage
     fails, the row halts mid-step. No spinner that lies, no modal that
     apologises. A red hairline seam appears across the row, the row above
     stays ink, the row below stays ink, the failed row itself clips its
     label at the seam so you can see both halves and read the gap. Error
     state is geometry, not copy.

  2. "REVEAL" — from the teletext world. Any AI-suggested character name,
     voice assignment, or scene attribution is hidden behind a REVEAL
     pattern. Held (default) = the suggestion is blank space with a
     dim placeholder; revealed = ink text you can accept or reject. This
     prevents accidental auto-acceptance and makes the user's manual
     accept feel deliberate.

SEED KEY: f4d306aa (raised reference-manual, raised by depot-blind + teletext).

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying
its provenance.
-->

# DESIGN.md

This document records the visual world of the **ebook-converter** app after
the `design/system-reference-manual` branch. It is ground truth from the
built world, not an aspiration. Update this file whenever a durable visual
decision is added; do not rewrite it for a narrow refinement.

## The world in one paragraph

A boxed-software reference manual, opened flat. Chrome-yellow divider boards
between sections carry no mark at all — the yellow is structural, like the
colour of manila folder tabs in a 1990s office. Content panels sit on
bleached-calico paper ground (warm off-white, never pure white) with a single
short hard shadow that reads as a die-cut acetate leaf hinged a millimetre
above the divider. Black ink for prose, chrome-yellow for section headers
and the active tab, one hairline divider for structure. The vertical stepped
tab rail down the fore edge lists every chapter and every pipeline stage as
a tab you can click; the active tab is filled chrome-yellow, inactive tabs
are paper-cream with hairline border and ink labels. Errors are honest
stops — a row halts mid-step with two clipped labels meeting across a red
seam. AI suggestions are hidden behind a REVEAL pattern — held is blank
space, revealed is ink.

## Palette

Defined in `src/app/globals.css` under `:root` and `.dark`.

| Token | Light value | Dark value | Role |
|---|---|---|---|
| `--background` | warm off-white `#F8F5F0` | deep slate `#0F1116` | App ground |
| `--foreground` | near-black ink `#1A1614` | near-white ink `#F0EDE4` | Body text |
| `--paper` | bleached calico `#F2EDE2` | deep calico `#1B1814` | Content-panel ground |
| `--ink` | `#1A1614` | `#F0EDE4` | Prose |
| `--ink-soft` | `#5C544A` | `#A39A8B` | Secondary text, metadata |
| `--chrome-yellow` | `#F2C12E` | `#E8B72A` | Active tab, section header, accent |
| `--chrome-yellow-dim` | `#FFF1C8` | `#3A2F0E` | Hover/selected surface, dim tab indicator |
| `--acetate` | `rgba(26,22,20,0.06)` | `rgba(240,237,228,0.06)` | Hairline overlay tint |
| `--hairline` | `rgba(26,22,20,0.18)` | `rgba(240,237,228,0.18)` | 1px structural divider |
| `--seam` | `#B5341E` | `#E25C42` | Failure seam (depot-blind raise) |
| `--hold` | `#8C857A` | `#6B665D` | REVEAL placeholder ink (teletext raise) |

The `--reader-*` tokens from the prior system remain and are reused by the
EbookReader panel. The accent palette stays minimal: chrome-yellow is the
single committed accent; semantic colours (red for destructive, green for
success) stay muted and structural rather than neon.

## Type

| Role | Family | Size | Weight | Tracking |
|---|---|---|---|---|
| Section header (h1) | Inter | 18 px | 600 | -0.01em |
| Chapter title (h2) | Inter | 14 px | 600 | 0 |
| Tab label | Inter | 12 px | 500 | 0.02em uppercase |
| Body prose | Literata | 15 px | 400 | 0 |
| Metadata / muted | Inter | 12 px | 400 | 0 |
| Tabular numerals | Inter | 13 px | 500 | 0.04em |

Numerals in tables, voice plans, and progress are tabular so columns align.
The Literata serif is reserved for prose and reader surfaces; chrome surfaces
(tabs, panels, buttons) stay in Inter for legibility at small sizes.

## Components

### Tab rail (`<TabRail>`)

Vertical column, 220 px wide on desktop (collapses to a top bar on mobile).
Each item is a rectangle, 36 px tall, paper-cream ground with hairline
border. Active tab is filled chrome-yellow with ink label. Hover inactivates
to a faint acetate tint. Drag the rail to scroll; arrow keys move focus.

### Acetate card (`<AcetateCard>`)

A content panel on paper ground with a single short hard shadow
(`box-shadow: 0 1px 0 var(--hairline)`). No border-radius beyond 2 px.
Optional `reveal` slot holds AI suggestions behind a REVEAL button.

### Honest-stop row (`<PipelineStep>`)

A 32-px-tall row inside a pipeline list. Three visual states:

- **pending** — ink-soft label, paper ground, hairline border, no fill
- **active** — chrome-yellow-dim ground, ink label, hairline border
- **halted** — first half of label ink, second half clipped at a 1-px
  vertical `--seam` line, hairline border

The label text is masked with a CSS gradient at the seam so it visually
splits. No spinner animation, no shake, no apology. The row just stops.

### Reveal gate (`<RevealGate>`)

Wraps any block that contains an AI suggestion. Default state shows a
placeholder line in `--hold` ink. Click REVEAL to swap to the real content.
The REVEAL button is a 12-px uppercase Inter button on chrome-yellow-dim
ground, ink label, hairline border. No icon, no animation.

## Layout

App shell uses a three-column grid on desktop:

```
┌─────────┬──────────────────────────┬────────────────────┐
│  Tab    │  Chapter content         │  Voice plan +      │
│  rail   │  (paper ground)          │  audio status      │
│  220px  │  AcetateCard stack       │  (paper ground)    │
└─────────┴──────────────────────────┴────────────────────┘
```

On mobile (`< 768px`), the tab rail collapses to a horizontal scrolling bar
under the page header; the right column stacks below the centre column.

## Motion

Minimal. One rule: a tab click transitions the chrome-yellow fill in 80 ms
`ease-out`. Reveal gates have no transition — the swap is instant and
deliberate. Honest-stop rows never animate; the failure appears.

## Accessibility

- All text meets WCAG 2.2 AA contrast against its ground (chrome-yellow on
  ink ≈ 7.4:1; ink on paper ≈ 13.8:1).
- Tab rail is keyboard-navigable: Arrow keys move focus, Enter activates.
- Reveal gates are buttons, focus-visible by default.
- Honest-stop rows have `aria-live="polite"` so screen readers announce the
  halt once.

## Out of scope

- Reader panel — keeps the existing `--reader-*` tokens and Literata serif
  rendering. Reference-manual shell frames it but does not change its
  interior.
- TTS service (Python runtime) — out of scope; lives on the host.
- Drag-and-drop chapter reordering — punted to a future refinement.
