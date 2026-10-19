import { defineConfig } from "astro/config";

// Static output; the Worker in wrangler.jsonc serves `dist/` as assets only.
export default defineConfig({
  site: "https://northguild.dev",
  output: "static",
});
