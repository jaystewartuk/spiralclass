// Tailwind 4 moved its PostCSS plugin into its own package; `tailwindcss`
// itself is no longer a PostCSS plugin and errors if used as one.
//
// No autoprefixer: v4's engine prefixes what still needs prefixing on its own,
// and its browser floor (Safari 16.4 / Chrome 111 / Firefox 128) is above the
// point where the properties this app uses need a prefix at all.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
