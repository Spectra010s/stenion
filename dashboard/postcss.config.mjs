// Tailwind CSS v4 is wired through PostCSS. No tailwind.config.js — v4 is
// CSS-first: design tokens and theme live in app/globals.css under @theme, and
// source files are auto-detected, so there's no `content` array to maintain.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
