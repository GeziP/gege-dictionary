/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: 'var(--surface)',
        raised: 'var(--raised)',
        sunken: 'var(--sunken)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        ink: 'var(--ink)',
        'ink-muted': 'var(--ink-muted)',
        'ink-subtle': 'var(--ink-subtle)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-soft': 'var(--accent-soft)',
        'accent-line': 'var(--accent-line)',
        'accent-ink': 'var(--accent-ink)',
        positive: 'var(--positive)',
        warn: 'var(--warn)',
        danger: 'var(--danger)',
        highlight: 'var(--highlight)',
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        serif: ['"Gentium Book Plus"', '"Charis SIL"', 'Georgia', 'serif'],
        ipa: ['"Gentium Book Plus"', '"Charis SIL"', '"Doulos SIL"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        window: '0 24px 60px -12px rgb(0 0 0 / 0.35), 0 4px 12px -4px rgb(0 0 0 / 0.18)',
        float: '0 18px 44px -10px rgb(0 0 0 / 0.32), 0 2px 8px -2px rgb(0 0 0 / 0.16)',
        panel: '0 1px 2px 0 rgb(0 0 0 / 0.06)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
