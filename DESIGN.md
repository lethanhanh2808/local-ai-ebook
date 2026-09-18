# DESIGN.md

This document records the visual world of the **ebook-converter** app on the
`design/system-reference-manual` branch (rebased to the East-Asian paper
direction). It is ground truth from the built world, not an aspiration.
Update this file whenever a durable visual decision is added; do not
rewrite it for a narrow refinement.

## The world in one paragraph

A manuscript of East-Asian classical paper opened flat. The whole viewport is
a single sheet of aged xuan paper (rice paper, kozo fiber texture visible),
warm off-white with the slightest ochre cast from age. Sumi ink carries the
prose — three grades (dense, medium, dilute) used by weight, never by hue.
Chapter titles sit in brush-script serif (宋体 / Songti, with Noto Serif SC as
the web fallback), spaced, ink-black. Vermilion seal paste (朱砂, cinnabar)
stamps a single square at each major section break — hand-cut, edges slightly
uneven, the colour applied as if pressed moments ago. The centre column of
prose is bounded at ~960 px so a single page reads like a folded leaf within
the larger canvas; the surrounding canvas (full viewport width on
1920×1080) is a darker, more aged paper tone, giving the content a sense of
resting on a folio on a darker surface. 乌丝栏 (horizontal ruling) appears as
faint blue-black lines framing the prose column. Vertical reading (竖排) is
reserved for the left rail — chapter subtitle and decorative marginalia read
top-to-bottom, right-aligned.

## Palette

Defined in `src/app/globals.css` under `:root` and `.dark`. Light and dark
modes both lean warm (the paper is always warm, never neutral grey).

| Token | Light value | Dark value | Role |
|---|---|---|---|
| `--paper` | aged xuan `#F2EAD6` | aged xuan dark `#1A1612` | Whole-viewport ground |
| `--paper-deep` | aged xuan deep `#E6D9B8` | aged xuan deep dark `#221C14` | Surface around content (canvas > content) |
| `--paper-card` | fresh xuan `#F8F2E0` | fresh xuan dark `#241D14` | Content panel ground (the "folded leaf") |
| `--ink` | sumi dense `#1A1410` | sumi-dilute-on-dark `#EDE3CC` | Body text |
| `--ink-medium` | sumi medium `#3A2E22` | sumi-medium-on-dark `#C9BFA6` | Headings, emphasis |
| `--ink-soft` | sumi dilute `#6B5C44` | sumi-soft-on-dark `#948B73` | Secondary text, metadata |
| `--vermilion` | 朱砂 cinnabar `#B5341E` | vermilion dim `#D8583C` | Seal stamps, primary accent |
| `--vermilion-dim` | `#7A2418` | `#5A1E14` | Hover / pressed seal state |
| `--rule` | 乌丝栏 blue-black `#5A4E38` at 22% alpha | `#9A8E70` at 22% alpha | Vertical ruling under prose |
| `--fiber` | kozo fibre tint `#A8987A` at 6% | `#8A7E62` at 8% | Paper grain overlay |
| `--seal-edge` | `#3A1A12` | `#3A1A12` | Inner shadow line of seal stamp edges |
| `--cream` | `#F8F2E0` | `#EDE3CC` | Hover / focus wash on paper |

The chrome-yellow of the previous world is gone. The single committed accent
is vermilion (`--vermilion`). All buttons, active states, focus rings, and
section markers carry this one hue.

The `--reader-*` tokens from the prior system remain — they describe the
EbookReader panel surface, which is independent of the app shell. The reader
keeps its warm paper feel.

## Type

| Role | Family | Size | Weight | Tracking |
|---|---|---|---|---|
| Chapter title (h1) | Noto Serif SC | 28 px | 500 | 0.04em |
| Section header (h2) | Noto Serif SC | 16 px | 600 | 0.06em |
| Tab / chapter label | Noto Serif SC | 12 px | 500 | 0.18em (uppercase via CSS) |
| Body prose | Noto Serif SC | 15 px | 400 | 0.02em |
| Marginalia / side notes | Noto Serif SC | 13 px | 400 | 0.06em |
| Metadata / muted | Noto Sans SC | 11 px | 400 | 0.10em |
| Seal stamp text | Noto Serif SC | 14 px | 700 | 0 (stamped, not typeset) |

Noto Serif SC carries Song/Mincho style at typical weights — it is the web
fallback for the brush-script aesthetic. Vietnamese (Latin Extended-A + B)
characters render via the same family; the script is bicameral enough that
the stroke contrast reads correctly.

Numerals stay in Noto Sans SC, tabular, for tables and progress.

## Layout

The app shell uses a **content-on-canvas** model, not a centred-container
model. The canvas (paper) fills the viewport; the content sits as a single
fold within it.

```
┌────────────────────────────────────────────────────────────────────────┐
│  ░░░ aged-paper canvas (full viewport width) ░░░                        │
│                                                                        │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────┐   │
│  │  Left rail (240 px)  │  │  Centre column       │  │  Right rail  │   │
│  │  竖排 vertical:       │  │  max-width 960 px    │  │  (320 px)    │   │
│  │  chapter subtitle    │  │  paper-card ground   │  │  批注 notes  │   │
│  │  + seal stamp at base│  │  with 乌丝栏 ruling  │  │  side rail   │   │
│  └──────────────────────┘  └──────────────────────┘  └──────────────┘   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

The canvas background (aged-paper-deep) extends to every edge. The
content region sits centred, with margins that grow on wider screens. On
1920×1080, the content region reads as a folio laid on a larger surface;
on 1366×768, the rails collapse to icons and the centre column fills.

### Breakpoints

| Width | Layout |
|---|---|
| `< 768 px` (mobile) | Single column. Left rail collapses to a top header strip; right rail collapses to a bottom action bar. |
| `768–1280 px` | Two columns: left rail + centre. Right rail becomes a slide-out panel. |
| `≥ 1280 px` | Full three-column layout as drawn above. |
| `≥ 1920 px` | Same three-column; outer canvas gutter grows; content region stays centred at 960 px. |

The "always full-width shell, internal max-width per region" rule from the
session decision is implemented as: the canvas (paper) is always full
viewport width; individual regions carry their own internal max-widths.

## Components

### Seal stamp (`<SealStamp>`)

A square (40 px) vermilion block with 1-px inset shadow line on the bottom
edge (the carved character). The text inside is sumi-dense on vermilion,
set in Noto Serif SC at 14 px. Used as a section break marker, not as a
button. Animates once on mount: a 200 ms ease-out fade-in that simulates
ink spreading into the paper.

### Paper card (`<PaperCard>`)

A content panel on `--paper-card` ground with the kozo fibre overlay
applied as a `::before` pseudo at 6% opacity. Border is `--rule` at 22%
alpha, 1 px on the left only (right, top, and bottom borderless — the
ruling line is the column marker). Shadow is a single short hard line
below (the leaf hinge).

### Vertical reading rail (`<VerticalRail>`)

A 240 px wide column on the left. Content inside renders with
`writing-mode: vertical-rl` and `text-orientation: mixed`. The chapter
subtitle reads top-to-bottom, right-aligned within the rail. The seal
stamp anchors the bottom of the rail.

### Ink button (`<InkButton>`)

Two variants:

- **brush** — vermilion ground, sumi-dense text, 1 px `--seal-edge`
  border, hairline shadow. Primary action.
- **outline** — transparent ground, sumi-dense text, 1 px `--ink-medium`
  border. Secondary.

No pillowy corners (4 px max). No text shadows. No gradient fills.

### Marginalia (`<Marginalia>`)

A small block of secondary text in `--ink-soft` at 13 px, used in the
right rail. Renders with a single 1 px hairline at its left edge, the
same colour as the column ruling.

## Motion

One rule: seal stamps fade in once on mount (200 ms ease-out), simulating
ink pressing into paper. No other animation. No hover transitions on
buttons beyond an instant colour swap. No skeleton shimmer.

## Accessibility

- All text meets WCAG 2.2 AA contrast: sumi-dense on aged-paper ≈ 13.4:1
  (well above AA); vermilion on aged-paper ≈ 5.6:1 (AA Large, AA Normal
  for ≥ 18 px).
- Focus rings use a 2 px `--ink-medium` outline at 2 px offset — visible
  on both light and dark paper without the high-saturation chrome-yellow
  from the previous world.
- Vertical reading rail is decorative; the same chapter subtitle is also
  present as horizontal text in the left rail's `aria-label` so screen
  readers don't have to navigate vertical text.
- Seal stamps are `<aside>` elements with `aria-hidden="true"` if they
  carry no semantic content; otherwise they're labelled with the chapter
  title.

## Out of scope

- Reader panel — keeps its existing `--reader-*` tokens and Literata serif.
  The paper aesthetic frames it but does not change its interior.
- TTS service (Python runtime) — out of scope.
- Drag-and-drop chapter reordering — punted to a future refinement.

## Direction contract (artifact-comment form)

THESIS: The ebook-converter is a private library; the surface is one
manuscript page at a time. Sumi ink and vermilion seal are the only
saturated colours; everything else is paper.

OWN-WORLD: Aged xuan paper on a darker aged-paper canvas. Sumi ink in
three grades. 宋体 serif (Noto Serif SC). A single vermilion seal stamp
at each section break. 乌丝栏 ruling under prose. 竖排 vertical reading
in the left rail only.

STORY: The reader opens a chapter. The seal stamp fades in like ink
pressing into paper. The prose column sits on the centred fold; the
canvas extends to the viewport edges so a 1920×1080 monitor reads as a
desk surface with a folio laid on it. The reader scrolls; the seal stamp
remains anchored at the section break.

FIRST VIEWPORT: Aged-paper canvas filling the viewport. A single square
vermilion seal at top-left, 40 px. A chapter title in sumi-dense Song
serif centred above the column. Below: a 960 px wide content column on
fresh-paper ground, with 乌丝栏 ruling on the left edge. Left rail (240
px) carries the chapter subtitle in 竖排 vertical text; right rail (320
px) carries side notes in marginalia. The content column is bounded; the
canvas is not.

FORM: User-pinned East-Asian classical paper. Brief-driven; no catalog
match, so the world is authored from the user's words and the real
material references for xuan paper, sumi ink, cinnabar paste, and Song
typefaces. Seed key n/a (user-pinned beats the roll).

FINISH: unreviewed and undocumented is unfinished; this build ends with
the finish review, the verdict, DESIGN.md, and every shipping raster
carrying its provenance.
