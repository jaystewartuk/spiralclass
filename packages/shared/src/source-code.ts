// Where the product's own source lives, and under what licence.
//
// SpiralClass is a public repository under AGPL-3.0-only — the same value
// `package.json` carries — and the marketing site says so out loud: the site
// footer links here, and the /about "why you can trust it" grid explains what
// being able to read the code buys a teacher. Both read these constants rather
// than hardcoding a URL, so a rename or a move is one edit and the three
// locales cannot drift from the LICENSE file.
//
// It is a claim the repository has to keep true. If this ever goes private,
// delete the footer link and the trust card in the same change — a dead
// "source code" link on a trust page costs more than the link ever won.
export const SOURCE_CODE_URL = "https://github.com/jaystewartuk/spiralclass";

// The SPDX identifier, interpolated into the /about copy via {licence}.
export const SOURCE_CODE_LICENCE = "AGPL-3.0-only";
