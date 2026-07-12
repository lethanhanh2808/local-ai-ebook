# UI primitives — README

All primitives the app reuses for cards, modals, form controls,
navigation, and feedback surfaces. New work should compose these instead of
inlining raw `<div>` shells or hand-rolling focus traps.

The catalogue is grouped by role. Each entry lists what it wraps, the
typical use site, and what to reach for instead.

> 2026-07-12 cleanup: removed unused primitives — `<Sheet>` (no callers),
> `<Callout>` (no callers), `<ConfirmDialog>` (no callers), `<Separator>`,
> `<Skeleton>` / `<LoadingSkeleton>` (no callers), bare `<Label>`/`<Textarea>`
> (no callers — wrap `<Input>` instead), UI `<ErrorState>` (the
> `components/layout/ErrorState.tsx` variant is kept and is the canonical
> retry surface), and `<BackLink>` (no callers — nav pattern never landed).
> Use the surviving primitives below; the file was pruned to match.

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
| **z-10** | Internal stacking inside a primitive (sticky toolbar rows above page content but below overlays). | Sticky rows inside a `Card` |
| **z-30** | Tooltips — must float above buttons/dropdowns but stay dismissable. | `<Tooltip>` content |
| **z-50** | Floating UI that doesn't need to interrupt the user: dropdown menus, select popovers, toast container. | `<DropdownMenu>`, `<Select>` content, `<Toast>` viewport |
| **z-60** | Modal dialogs. Sits above toasts so a destructive confirm isn't hidden under a notification. | `<Dialog>` overlay |
| **z-70** | Reserved for emergency tier — currently unused (kept for the next destructive-prompt variant on top of an existing modal). | — |
| **z-100 … z-102** | Reserved for **portaled overlays above the active modal** (e.g. the reader's keyboard-shortcuts overlay while the reader is full-screen). Only valid inside a React portal that owns the entire viewport. | Reader shortcuts overlay (EbookReader) |

Anything outside this scale must justify itself with a comment in the
PR description and live in a portal with `pointer-events: none` on its
backdrop, so it can't trap clicks behind another primitive.

Audit grep (run this when adding a new primitive):

```bash
grep -rE "z-\[[0-9]+\]|z-[0-9]+ " src/components/ui/ src/components/library/EbookReader.tsx
```

The few remaining `z-[…]` literals across the codebase all live inside the
above tiers (see `EbookReader.tsx` for z-100/101/102 inside its portal).

**Allowlist for the audit gate** (`fixed inset-0 z-[…]` outside the
primitives folder is permitted only for sibling backdrops):

- `src/components/library/ReadAloudPanel.tsx` — sibling backdrop at
  `z-[55]` sits *below* the panel's own `z-[60]`. Intentional 2-layer
  pattern (backdrop + panel). Migrated earlier; kept on the same tier.

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

---

## Overlays

### `<Dialog>`

**File:** `dialog.tsx` (hand-rolled, **not** Radix)

Multi-dialog stack with shared focus trap, body scroll lock with previous
overflow restore, focus save/restore via microtask, and `prefers-reduced-motion`
honoured. This is the canonical overlay — destructive confirms, prompt
dialogs, all of it. Pass `destructive` to render the warning variant.

```tsx
<Dialog open={open} onOpenChange={setOpen} title="Delete book?" description="…">
  <DialogBody>…</DialogBody>
  <DialogFooter>
    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
    <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
  </DialogFooter>
</Dialog>
```

Do not reach for Radix `react-dialog` directly — the hand-rolled
primitive owns focus trap, scroll lock, and reduced-motion behaviour.

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

---

## Form controls

### `<Button>`

**File:** `button.tsx`

Variants: `default | outline | ghost | destructive | secondary | link`.
Sizes: `sm | md | lg | icon`. Wrap every clickable thing in this — no
bare `<button>` with bespoke Tailwind classes.

### `<Input>`

**File:** `input.tsx`

Replaces bare `h-9 rounded-md border bg-background px-3` inputs. Pair
`<label htmlFor=…>` (plain `<label>` is fine here) with the input it
labels for click-to-focus + screen-reader support.

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
when a destructive action needs confirmation but doesn't warrant a full
`<Dialog>` (e.g. "Remove bookmark?").

### `<Progress>`

**File:** `progress.tsx`

ARIA-correct progress bar with `role="progressbar"`,
`aria-valuenow/min/max`, optional `label`. Falls back to indeterminate
when the value is unknown. Use for upload progress, chapter-level
progress inside the reader, and the voice-preview playing indicator.

### `<EmptyState>` / `<ErrorState>`

**Files:** `components/layout/EmptyState.tsx`, `components/layout/ErrorState.tsx`

`<ErrorState onRetry={refetch}>` for fetch failures that previously
swallowed errors silently. Surfaces a Retry button + collapsible
details. Audit gates:

```bash
grep -rE "fetch\(.*\)\.catch\(\(\) => \[\]\)" src/
```

should return zero matches.

---

## Navigation

### `<PageHeader>` + `<BreadcrumbItem>`

**File:** `components/layout/PageHeader.tsx`

Every page gets one. Renders breadcrumbs above the title when
`breadcrumbs={[{label, href?}, …]}` is passed; the last entry is the
current page (non-link, de-emphasized, `aria-current="page"`).

---

## Theme

### `<ThemeToggle>`

**File:** `theme-toggle.tsx`

3-state: `Sun` / `Moon` / `Monitor` via `<DropdownMenu>`. Eliminates the
unreachable `system` mode of the original 2-state button.

---

## When to reach for what

| You need… | Reach for |
|---|---|
| A container with border + padding | `<Card>` |
| A modal confirm (including destructive) | `<Dialog>` (set `destructive`) |
| A dropdown of choices | `<DropdownMenu>` (menu) or `<Select>` (form control) |
| A boolean toggle | `<Switch>` |
| A keyboard shortcut hint | `<KbdHint>` |
| A failed fetch retry surface | `<ErrorState onRetry={refetch}>` (from `components/layout`) |
| A non-blocking notification | `toast.*` |
| A progress bar | `<Progress>` |
| A tabbed page | `<Tabs>` |
| A tooltip on an icon button | `<Tooltip>` |

If a primitive you need isn't here, **add it to this file in the same
PR** — undocumented primitives rot.
