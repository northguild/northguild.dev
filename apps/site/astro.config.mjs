import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Static output; the Worker in wrangler.jsonc serves `dist/` as assets only.
export default defineConfig({
  site: "https://northguild.dev",
  output: "static",
  // The 404 page is not a page to list.
  integrations: [
    sitemap({
      filter: (page) => !/\/404\/?$/.test(new URL(page).pathname),
    }),
  ],
});
