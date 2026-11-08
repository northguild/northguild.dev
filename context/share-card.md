# Share card

The picture that link-preview apps show for `northguild.dev/` and its 404 page:
`apps/site/public/og.png`, 1200 x 630, served from `/og.png`.

## What it is

Aurora sky, with a dark glass panel in the middle. On the panel the shield sits above the
"NorthGuild" wordmark (Michroma) and the line "Open-source tools for developers.".

- **Square-safe.** Some apps cut a 630-pixel square from the middle of the card
  (x 285 to 915). The column and the panel sit inside it with a margin, so nothing is cut.
  The aurora outside the square is decoration only.
- **Under 300 KB.** WhatsApp loads no preview image over 300 KB. The card is a palette PNG
  (about 145 KB).
- **Text contrast** is at least 4.5:1; the script fails below that.

## Regenerate

```sh
eval "$(fnm env)" && fnm use && node scripts/build-og-card.mjs
```

Run it by hand, never in the build. It is deterministic: the same bytes every run. It writes
`apps/site/public/og.png` and the same bytes to `apps/site/assets/share/og-1200x630.png`
(the copy to upload by hand; see the README there).

Its sources: `apps/site/assets/share/og-sky.png` (the previous card, whose aurora is the
sky; keep it, because `og.png` is overwritten), the shield paths of
`NorthGuildMark.astro`, `scripts/fonts/Michroma-Regular.ttf` (SIL OFL text beside it) and
the `@northguild/theme` colours as RGB values. `sharp` and `canvaskit-wasm` are root dev
dependencies.

## The `?v=` rule

`Base.astro` ends `og:image` and `twitter:image` in `?v=` plus the first 12 hex digits of the
SHA-256 of `public/og.png`. `astro.config.mjs` hashes the file once per build and hands the
value to `Base.astro` as `__OG_CARD_HASH__`. Platforms such as Facebook and LinkedIn cache
a card by URL, so a new card needs a new URL. Change the card, rebuild, and the address
changes by itself; never edit the hash by hand. After a deploy, ask each platform's debugger
to scrape the page again.
