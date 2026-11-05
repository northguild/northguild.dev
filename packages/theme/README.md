# @northguild/theme

CSS only. Private; never published to a registry. Each file copied from GMT
names its source file and the GMT commit in its header. `tokens-aurora.css` is
NorthGuild's own.

## Files

- `tokens.css`: dark `:root` tokens and the Michroma `@font-face`.
- `tokens-light.css`: the `[data-theme="light"]` overrides; omit for dark-only.
- `tokens-aurora.css`: the aurora's colours for the sky (NorthGuild's own).
- `primitives.css`: component recipes below.
- `fonts/michroma-latin-400-normal.woff2`: the display font.

## Token groups (`--gmt-*`)

- Colour roles: `void`, `cyan`, `spring`, `teal`, `ice` (and `-dim`, `-bright` variants).
- Aurora light, for the sky: `aurora-green`, `aurora-red`, `aurora-fringe`,
  in `tokens-aurora.css` (NorthGuild's own, not copied from GMT).
- Surfaces and fills: `surface`, `fill`, `fill-subtle`, `fill-strong`, `glass-tint*`.
- Lines: `border`, `border-strong`, `hairline`, `highlight`, `glow`.
- Type: `font-mono`, `font-display`.
- Space and shape: `space-*`, `radius-*`.
- Glass: `blur`, `blur-heavy`, `saturate`, `brightness`.
- Motion: `duration-*`, `easing`, `motion-sonar-*`.

## Classes

- `.gmt-glass`: the tinted, bevelled glass surface with a hairline gradient.
- `.gmt-glass-subtle`: near-transparent glass for nesting.
- `.gmt-glass-clear`: faint frost for overlays.
- `.gmt-glass-heavy`: deeper wash for elevated surfaces.
- `.gmt-brackets`: L-shaped corner brackets.
- `.gmt-icon-button`: transparent icon button with a glass chip on hover.
- `.gmt-sonar-focus`: the one-shot focus ping ring.
- `.gmt-sonar-loop`: the same ping on a permanent loop.
- `.gmt-field`: bevelled text input.
- `.gmt-button`: small bevelled button.

A `prefers-reduced-motion` reset collapses all animation and transition time.
