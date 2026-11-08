import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// The first 12 hex digits of the share card's SHA-256, hashed once per build.
// Base.astro ends the card's URL in `?v=` plus this (context/share-card.md).
const ogCardHash = createHash("sha256")
  .update(readFileSync(new URL("./public/og.png", import.meta.url)))
  .digest("hex")
  .slice(0, 12);

// Static output; the Worker in wrangler.jsonc serves `dist/` as assets only.
export default defineConfig({
  site: "https://northguild.dev",
  output: "static",
  // @astrojs/sitemap leaves the 404 and 500 pages out of the sitemap itself.
  integrations: [sitemap()],
  vite: { define: { __OG_CARD_HASH__: JSON.stringify(ogCardHash) } },
});
