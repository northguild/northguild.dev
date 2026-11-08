# Share images

Upload-ready images for the places that take a picture by hand.

| File                 | Size       | Use                                                                                      |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `og-1200x630.png`    | 1200 x 630 | The site card, the same bytes as `public/og.png`. For profiles and listings.            |
| `og-sky.png`         | 1200 x 630 | The previous card. The script reads its aurora as the sky; not for upload.              |

The card stacks the shield, the wordmark and the line in a column centred in the middle
630 pixels, so an app that crops a square keeps all of it. It is a palette PNG under 300 KB,
the most WhatsApp loads.

Regenerate it, with the same bytes each time (it writes `public/og.png` and `og-1200x630.png`):

```sh
node scripts/build-og-card.mjs
```

Upload `og-1200x630.png` where a card is set by hand: the GitHub organisation profile and
any directory listing. The site itself serves `public/og.png`.

This folder is outside `public/`, so the site build does not publish it.
