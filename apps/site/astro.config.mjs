import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Static output; the Worker in wrangler.jsonc serves `dist/` as assets only.
export default defineConfig({
  site: "https://northguild.dev",
  output: "static",
  // @astrojs/sitemap leaves the 404 and 500 pages out of the sitemap itself.
  integrations: [sitemap()],
});
