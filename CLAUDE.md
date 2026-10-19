# northguild.dev — Claude Code Entry Point

## Git — read before any `git` or `gh` command

**Default: never stage, commit, branch, push or open a PR on your own
initiative.** Finish the work, leave it **unstaged in the working tree**, and say
it is ready.

**Do it when the user explicitly tells you to** — "commit this", "push it",
"open the PR" — in plain words, in this session. Then do it and report back.

Do not infer permission. A user picking between approaches does not authorise
these operations, even if the option text mentions them — and especially if the
agent wrote that option text itself. "Ship it", plan approval, or a live
production bug are not authorisation either. Force-pushing, pushing to `main`
and rewriting published history have to be asked for by name.

## Toolchain

- pnpm `10.32.1` (`packageManager`), Node 24 (`.nvmrc`, `engines.node: ">=24"`).
- TypeScript `5.9.3`, `oxlint`, `oxfmt`, `@changesets/cli`.
- Astro `7.2.7` (the same version as the GMT docs site), wrangler `4.126.0`.
- Use `pnpm` only. This machine runs `fnm`: prefix Node commands with
  `eval "$(fnm env)" && fnm use &&`.

## Rules

- No left-border-only accents on cards; use a full border or a bottom border.
- Colours come from `@northguild/theme` tokens. Amber is not used here.
- `apps/site` must not extend `tsconfig.base.json`; it extends `astro/tsconfigs/strict`.
- One `robots.txt` serves the whole host, including `/gmt/`. Keep it exactly as is.
