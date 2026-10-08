/**
 * The theme colours are CSS variables (src/index.css), so that light and dark share one set
 * of classes. Tailwind cannot add transparency to a variable by itself: a class such as
 * `bg-danger/5` or `border-line/60` then produces no CSS at all, which left every tinted
 * error banner in the app without its tint. Mixing the variable with `transparent` is the
 * same thing as an alpha channel.
 */
const THEME_COLORS = [
  'canvas',
  'surface',
  'raised',
  'sunken',
  'line',
  'line-strong',
  'ink',
  'ink-muted',
  'ink-subtle',
  'accent',
  'accent-hover',
  'accent-soft',
  'accent-line',
  'accent-ink',
  'positive',
  'warn',
  'danger',
  'highlight',
];

const themeColor = (name) => ({ opacityValue }) => {
  const alpha = Number.parseFloat(opacityValue);
  // No modifier, or Tailwind's own `--tw-*-opacity` variable: the colour as it is.
  if (!Number.isFinite(alpha)) return `var(--${name})`;
  return `color-mix(in srgb, var(--${name}) ${Math.round(alpha * 10000) / 100}%, transparent)`;
};

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: Object.fromEntries(THEME_COLORS.map((name) => [name, themeColor(name)])),
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        serif: ['"Gentium Book Plus"', '"Charis SIL"', 'Georgia', 'serif'],
        ipa: ['"Gentium Book Plus"', '"Charis SIL"', '"Doulos SIL"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1.45' }],
        xs: ['0.75rem', { lineHeight: '1.5' }],
        sm: ['0.8125rem', { lineHeight: '1.55' }],
        base: ['0.875rem', { lineHeight: '1.6' }],
        lg: ['1rem', { lineHeight: '1.5' }],
        xl: ['1.25rem', { lineHeight: '1.3' }],
        '2xl': ['1.625rem', { lineHeight: '1.2' }],
      },
      spacing: {
        titlebar: '2.25rem',
        toolbar: '3rem',
        control: '1.75rem',
        'control-lg': '2rem',
      },
      width: {
        rail: '11.5rem',
        filter: '13rem',
        drawer: '29rem',
        popup: '23rem',
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
