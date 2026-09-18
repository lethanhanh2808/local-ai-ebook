/** @type {import('tailwindcss').Config} */
// East-Asian classical paper direction (DESIGN.md). The container cap
// is removed — the shell is always full viewport width, individual
// regions carry their own max-widths (`max-w-content` = 960 px centre
// column; rails have fixed widths). This is the session decision:
// "Always full-width, internal max-width per region".
module.exports = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    // The Tailwind `container` utility is intentionally NOT capped. Pages
    // compose their own regions with `max-w-content` / `max-w-rail-*` so
    // a 1920×1080 monitor reads as a folio laid on a desk surface, not
    // a centred SaaS card.
    container: false,
    extend: {
      fontFamily: {
        // Brushed serif — the chrome voice. Song/Mincho style. Used for
        // headings, body prose, and the page chrome itself. `serif` is
        // the final fallback so a user with no web fonts still sees a
        // serif app, not a slabby system sans.
        serif: ['Noto Serif SC', 'Songti SC', 'Cambria', 'Georgia', 'serif'],
        // Sans is reserved for inline metadata and tabular data; the
        // shell never uses it as the body voice.
        sans: ['Noto Sans SC', 'Inter', 'system-ui', 'sans-serif'],
        // Literata is bundled as a TTF for the EPUB enhancer (Reader
        // surface). Kept here so `font-literata` resolves if a future
        // shell surface needs the same bookish voice.
        literata: ['Literata', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
      },
      maxWidth: {
        // The content column on the dashboard / library / convert pages.
        // Centre of the three-column layout. Bounded so a single page
        // reads like a folded leaf on the larger canvas.
        content: '960px',
        // Wide content surface for the reader itself (the page area,
        // not the surrounding chrome).
        reader: '760px',
        // Tailwind's default `screen-2xl` is 1536 px — kept here for
        // rails or modal widths that want a different bound than the
        // centre column.
        canvas: '1800px',
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        // Modal backdrop tint.
        'modal-overlay': 'hsl(var(--modal-overlay) / <alpha-value>)',
        // Paper-depth — the slightly darker canvas tone that surrounds
        // the content card on wide viewports. Exposed as `bg-paper-deep`.
        'paper-deep': 'hsl(var(--paper-deep))',
        // Reader paper / ink — exposed so reader sub-surfaces can be
        // painted without re-declaring CSS variables.
        'reader-paper': 'hsl(var(--reader-paper))',
        'reader-ink': 'hsl(var(--reader-ink))',
        'reader-ink-soft': 'hsl(var(--reader-ink-soft))',
        'reader-divider': 'hsl(var(--reader-divider))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
