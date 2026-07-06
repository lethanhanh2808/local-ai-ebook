# UI primitives — README

All primitives the app reuses for cards, modals, side panels, form controls,
navigation, and feedback surfaces. New work should compose these instead of
inlining raw `<div>` shells or hand-rolling focus traps.

The catalogue is grouped by role. Each entry lists what it wraps, the
typical use site, and what to reach for instead.

---

## Table of contents

- [z-index scale (canon)](#z-index-scale-canon)
- [Surfaces](#surfaces)
- [Overlays](#overlays)
- [Menus & popovers](#menus--popovers)
- [Form controls](#form-controls)
- [Feedback](#feedback)
- [Navigation](#navigation)
- [Theme](#theme)

---

## z-index scale (canon)

Every primitive stacks on this scale. Pick the lowest tier that still
solves the stacking problem — don't invent `z-[55]` or `z-[73]`; if the
existing tiers can't satisfy your case, extend the scale deliberately.

| Tier | Use for | Consumer |
|---|---|---|
| **z-10** | Internal stacking inside a primitive (e.g. sheet body content above its own scroll edge), and sticky toolbar rows that should sit *above* page content but *below* everything overlay-y. | `<Sheet>` body (relative z-10) |
| **z-30** | Tooltips — must float above buttons/dropdowns but stay dismissable. | `<Tooltip>` content |
| **z-50** | Floating UI that doesn't need to interrupt the user: dropdown menus, select popovers, toast container. | `<DropdownMenu>`, `<Select>` content, `<Toast>` viewport |
| **z-60** | Modal dialogs and side panels. Sits above toasts so a destructive confirm isn't hidden under a notification. | `<Dialog>`, `<Sheet>` overlay |
| **z-70** | Alert dialogs (destructive confirms). Above all other modals — the user must see and dismiss this before doing anything else. | `<AlertDialog>` |
| **z-100 … z-102** | Reserved for **portaled overlays above the active modal** (e.g. the reader's keyboard-shortcuts overlay while the reader is full-screen). Only valid inside a React portal that owns the entire viewport. | Reader shortcuts overlay (EbookReader) |

Anything outside this scale must justify itself with a comment in the
PR description and live in a portal with `pointer-events: none` on its
backdrop, so it can't trap clicks behind another primitive.

Audit grep (run this when adding a new primitive):

```bash
grep -rE "z-\[[0-9]+\]|z-[0-9]+ " src/components/ui/ src/components/library/EbookReader.tsx
```

The 9 actual `z-[…]` literals across the codebase all live inside the
above tiers (see `EbookReader.tsx` for z-100/101/102 inside its portal).

**Allowlist for the audit gate** (`fixed inset-0 z-[…]` outside the
primitives folder is permitted only for sibling backdrops):

- `src/components/library/ReadAloudPanel.tsx` — sibling backdrop at
  `z-[55]` sits *below* the panel's own `z-[60]`. Intentional 2-layer
  pattern (backdrop + panel). Phase 3 §3.1 row 4 listed migration to
  `<Sheet>`; deferred because the parent reader dialog already owns
  focus-trap and the slide-in animation is hand-tuned.

---

## Surfaces

### `<Card>` / `<CardHeader>` / `<CardTitle>` / `<CardDescription>` / `<CardContent>` / `<CardFooter>` / `<CardAction>`

**File:** `card.tsx`

Lightweight `rounded-xl border bg-card` shell. Replace every ad-hoc
`<div className="rounded-xl border bg-card …">` in feature code — the
goal is one place to tweak the elevation, padding, and dark-mode parity.

```tsx
<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
    <CardDescription>Subtitle</CardDescription>
    <CardAction><Button>Edit</Button></CardAction>
  </CardHeader>
  <CardContent>…</CardContent>
  <CardFooter>…</CardFooter>
</Card>
```

Override padding with `className="p-4"` for compact surfaces (job cards,
toggle rows).

### `<Callout>`

**File:** `callout.tsx`

`<div role="note">` with tone variants (`info`, `success`, `warning`,
`danger`). For inline help text, beta banners, and policy hints. Visually
distinct from `<Card>` so the user doesn't read it as a container.

```tsx
<Callout tone="info">New in 2026.07 — see changelog.</Callout>
```

---

## Overlays

### `<Dialog>`

**File:** `dialog.tsx` (hand-rolled, **not** Radix)

Multi-dialog stack with shared focus trap, body scroll lock with previous
overflow restore, focus save/restore via microtask, and `prefers-reduced-motion`
honoured.

```tsx
<Dialog open={open} onOpenChange={setOpen} title="Delete book?" description="…">
  <DialogBody>…</DialogBody>
  <DialogFooter>
    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
    <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
  </DialogFooter>
</Dialog>
```

Used as the substrate for `<Sheet>` and `<AlertDialog>` — don't reach
for Radix `react-dialog` directly.

### `<Sheet>`

**File:** `sheet.tsx` (wraps `@radix-ui/react-dialog`)

Side panel (`side="right|left|top|bottom"`) with optional `width`/`height`
slot. The analyzer drawer and Read-Aloud panel compose this; both pass
`closeOnBackdrop={false}` because the user should explicitly dismiss them.

```tsx
<Sheet open={open} onOpenChange={setOpen} side="right" width={480}>
  …
</Sheet>
```

### `<AlertDialog>`

**File:** `alert-dialog.tsx` (wraps `@radix-ui/react-alert-dialog`)

Destructive confirms — focus is forced on the cancel button by default
so a stray Enter doesn't trigger the dangerous action.

```tsx
<AlertDialog
  open={open} onOpenChange={setOpen}
  title="Dừng worker?"
  description="Mọi conversion đang chạy sẽ bị huỷ."
  confirmLabel="Dừng"
  destructive
  onConfirm={stopWorker}
/>
```

---

## Menus & popovers

### `<DropdownMenu>`

**File:** `dropdown-menu.tsx` (Radix)

Overflow menus, view-mode pickers, chapter-jump lists. Pair with
`<Tooltip>` on the trigger to surface the keyboard shortcut.

### `<Select>`, `<SelectGroup>`, `<SelectValue>`, `<SelectTrigger>`, `<SelectContent>`, `<SelectItem>`

**File:** `select.tsx` (Radix)

Replaces native `<select>`. Use for analyzer-mode picker, language
picker, model picker (when the provider returns a list), boolean-as-enum
dropdowns.

### `<Tooltip>`

**File:** `tooltip.tsx` (Radix)

Surface the `title=` of every icon button. Pairs naturally with
`<KbdHint>` for keyboard shortcuts:

```tsx
<Tooltip content={<>Open table of contents <KbdHint>T</KbdHint></>}>
  <Button size="icon" variant="ghost" aria-label="Open table of contents">…</Button>
</Tooltip>
```

### `<Separator>`

**File:** `separator.tsx` (Radix)

`<hr>`-equivalent that announces itself to screen readers. Use between
sections of a menu, or between major regions of a Card body.

---

## Form controls

### `<Button>`

**File:** `button.tsx`

Variants: `default | outline | ghost | destructive | secondary | link`.
Sizes: `sm | md | lg | icon`. Wrap every clickable thing in this — no
bare `<button>` with bespoke Tailwind classes.

### `<Input>`, `<Textarea>`, `<Label>`

**Files:** `input.tsx`, `textarea.tsx`, `label.tsx`

Replace bare `h-9 rounded-md border bg-background px-3` inputs. Pair
`<Label htmlFor=…>` with the input it labels for click-to-focus + screen
reader support.

### `<Switch>`

**File:** `switch.tsx` (hand-rolled — Radix not needed)

Aria-correct toggle. Two states; for three-way logic use `<Select>` or
a `<DropdownMenu>` of radio items.

### `<Tabs>`, `<TabsList>`, `<TabsTrigger>`, `<TabsContent>`

**File:** `tabs.tsx` (Radix)

Underline-rail variant for ≥4 tabs; pill variant for 2-3. Used on
`/settings` (4 tabs: AI / TTS / Conversion / Image generation).

```tsx
<Tabs defaultValue="general">
  <TabsList>
    <TabsTrigger value="general">General</TabsTrigger>
    <TabsTrigger value="tts">TTS</TabsTrigger>
  </TabsList>
  <TabsContent value="general">…</TabsContent>
  <TabsContent value="tts">…</TabsContent>
</Tabs>
```

---

## Feedback

### `<Toast>`, `toast.*`

**File:** `toast.tsx`

For non-blocking notifications — save confirmations, network retry
hints, copy-link success. Use `toast.confirm({ destructive: true })`
when a destructive action needs confirmation but doesn't warrant an
`<AlertDialog>` (e.g. "Remove bookmark?").

### `<Progress>`

**File:** `progress.tsx`

ARIA-correct progress bar with `role="progressbar"`,
`aria-valuenow/min/max`, optional `label`. Falls back to indeterminate
when the value is unknown. Use for upload progress, chapter-level
progress inside the reader, and the voice-preview playing indicator.

### `<Skeleton>` / `<LoadingSkeleton>`

**File:** `skeleton.tsx` (shared); `<LoadingSkeleton>` lives in `components/layout`.

Pulse-animated placeholder for slow endpoints. Pair with `<EmptyState>`
and `<ErrorState>` so every list surface has the three-state pattern.

### `<EmptyState>` / `<ErrorState>`

**Files:** `components/layout/EmptyState.tsx`, `components/ui/error-state.tsx`

`<ErrorState onRetry={refetch}>` for fetch failures that previously
swallowed errors silently. Surfaces a Retry button + collapsible
details. Audit gates:

```bash
grep -rE "fetch\(.*\)\.catch\(\(\) => \[\]\)" src/
```

should return zero matches after Phase 2.

---

## Navigation

### `<PageHeader>` + `<BreadcrumbItem>`

**File:** `components/layout/PageHeader.tsx`

Every page gets one. Renders breadcrumbs above the title when
`breadcrumbs={[{label, href?}, …]}` is passed; the last entry is the
current page (non-link, de-emphasized, `aria-current="page"`).

### `<BackLink>`

**File:** `components/layout/BackLink.tsx`

`<Link>` + `<ChevronLeft>` + label. Use for explicit "← Back to Library"
affordances on sub-pages (`/library/[id]/edit`, `/shelves/[id]`).

---

## Theme

### `<ThemeToggle>`

**File:** `theme-toggle.tsx`

3-state: `Sun` / `Moon` / `Monitor` via `<DropdownMenu>`. Eliminates
the unreachable `system` mode of the original 2-state button.

---

## When to reach for what

| You need… | Reach for |
|---|---|
| A container with border + padding | `<Card>` |
| A modal confirm | `<Dialog>` (or `<AlertDialog>` if destructive) |
| A side panel that slides in | `<Sheet>` |
| A dropdown of choices | `<DropdownMenu>` (menu) or `<Select>` (form control) |
| A boolean toggle | `<Switch>` |
| A keyboard shortcut hint | `<KbdHint>` |
| A loading placeholder | `<Skeleton>` |
| A failed fetch retry surface | `<ErrorState onRetry={refetch}>` |
| A non-blocking notification | `toast.*` |
| A progress bar | `<Progress>` |
| A tabbed page | `<Tabs>` |
| A tooltip on an icon button | `<Tooltip>` |

If a primitive you need isn't here, **add it to this file in the same
PR** — undocumented primitives rot.