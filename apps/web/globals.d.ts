// Ambient declarations for side-effect asset imports.
//
// TypeScript 6 (TS2882) requires a type declaration for side-effect imports of
// non-code modules (e.g. `import "./globals.css"`). Next.js handles these at
// build time via its own loaders, but `tsc --noEmit` needs the ambient module.
declare module "*.css";
