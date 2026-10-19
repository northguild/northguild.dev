# northguild.dev

The NorthGuild landing page (`https://northguild.dev/`) and the shared theme.

- `apps/site`: the landing page. Astro, static, dark only, served by a
  Cloudflare Worker with assets only (no script).
- `packages/theme`: `@northguild/theme`, CSS tokens and primitives copied from
  the GMT docs site. Private; other repos install it from Git.

The GMT docs live at `https://northguild.dev/gmt/` and are served by a separate
Worker route. This site's `robots.txt` covers the whole host, `/gmt/` included.

## Run it

```sh
pnpm install
pnpm -r build        # build everything
pnpm check           # astro check
pnpm lint            # oxlint
pnpm format:check    # oxfmt --check
pnpm --filter @northguild/site dev      # Astro dev server
pnpm --filter @northguild/site preview  # wrangler dev on the built dist
```

## Deploy

Every push to `main` (and a manual run) triggers `.github/workflows/deploy.yml`:
build, then `wrangler deploy` for `apps/site`, which creates the Custom Domain
`northguild.dev`. A smoke step checks `/` is 200 and `/api/x` is 404.

Repository secrets: `CLOUDFLARE_API_TOKEN` (the landing token, with DNS Edit) and
`CLOUDFLARE_ACCOUNT_ID`.

## Use the theme from another repo

```json
"@northguild/theme": "github:northguild/northguild.dev#path:/packages/theme"
```

Then import `@northguild/theme/tokens.css` and `@northguild/theme/primitives.css`
(add `tokens-light.css` for a light theme).
