// Draws the share card for https://northguild.dev/ and its 404 page: 1200 by 630. Writes
// apps/site/public/og.png (what the site serves) and the same bytes to
// apps/site/assets/share/og-1200x630.png (the copy to upload by hand).
//
// Why it is made this way: a link-preview app may cut the 630-pixel square from the middle of
// the card (x 285 to 915), and WhatsApp loads no preview image over 300 KB. So the shield, the
// wordmark and the line stack in one column centred in that square, with a margin, and the
// card is written as a palette PNG.
//
// Sources, all in this repo:
// - the sky: the aurora in apps/site/assets/share/og-sky.png, the card this one replaced. Its
//   old glass panel, shield and text are painted out (a smooth blend of the sky around them,
//   plus a few stars), so the aurora stays as decoration on both sides of the square. Keep
//   that file: og.png is overwritten on every run.
// - the shield: the paths of apps/site/src/components/NorthGuildMark.astro.
// - the wordmark and the line: Michroma (SIL OFL), scripts/fonts/Michroma-Regular.ttf, the
//   same font @northguild/theme ships as woff2.
// - colours: --gmt-ice, --gmt-ice-dim, --gmt-cyan and --gmt-void of
//   @northguild/theme, as RGB triples.
//
// Run: node scripts/build-og-card.mjs   (by hand, never in the build; needs sharp and
// canvaskit-wasm, both root dev dependencies). It is deterministic: the same bytes every run.
// Prints the WCAG contrast of each text against the brightest pixel behind it, and fails
// below 4.5.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import CanvasKitInit from "canvaskit-wasm/full";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SKY = resolve(here, "../apps/site/assets/share/og-sky.png");
const FONT = resolve(here, "fonts/Michroma-Regular.ttf");
const OUT_SITE = resolve(here, "../apps/site/public/og.png");
const OUT_UPLOAD = resolve(here, "../apps/site/assets/share/og-1200x630.png");

const W = 1200;
const H = 630;
/** The square a link-preview app cuts from the middle of the card. */
const SAFE_LEFT = 285;
const SAFE_RIGHT = 915;
const CENTER = W / 2;

const VOID = [3, 8, 12];
const ICE = [207, 234, 242];
const ICE_DIM = [152, 178, 190];
const CYAN = [34, 211, 238];

/** The shield's shapes, from NorthGuildMark.astro, in a 1000 by 1317 box. */
const SHIELD = {
  w: 1000,
  h: 1317,
  outline:
    "M500 0 L0 179.1 L0 709.1 C0 1018.6 373.1 1206.2 500 1317 C626.9 1206.2 1000 1018.6 1000 709.1 L1000 179.1 Z",
  lit: "M500 0 L0 179.1 L0 709.1 C0 1018.6 373.1 1206.2 500 1317 Z",
  field:
    "M93.3 243.9 L500 99 L906.7 243.9 L906.7 686.5 L709.3 390.2 L654.9 470.3 L500 239.5 L345.1 470.3 L290.7 390.2 L93.3 686.5 Z",
  ridge:
    "M93.3 686.5 L290.7 390.2 L345.1 470.3 L500 239.5 L654.9 470.3 L709.3 390.2 L906.7 686.5",
  glyph:
    "M366 640 L212 736.5 L366 833 M634 640 L788 736.5 L634 833 M560 560 L443 910",
};

/** The column, top to bottom, in pixels. The block is centred on the card's middle row. */
const SHIELD_HEIGHT = 190;
const GAP_SHIELD = 26;
const GAP_LINE = 20;
/** The widest the wordmark and the line may be: the square less a margin each side. */
const MARGIN = 48;
const TEXT_WIDTH = SAFE_RIGHT - SAFE_LEFT - 2 * MARGIN;
const WORDMARK = "NorthGuild";
const LINE = "Open-source tools for developers.";
/** Panel behind the column. */
const PANEL = { x: SAFE_LEFT + 14, w: SAFE_RIGHT - SAFE_LEFT - 28 };
/** The 45-degree cut on each of the panel's four corners: the theme's bevel (.gmt-glass uses
    16px at page scale), enlarged to read at card size. */
const CHAMFER = 26;
/** Width of the panel's edge and hairline, in card pixels. */
const PANEL_LINE = 1.5;

/** Relative luminance of an sRGB colour (WCAG 2.2). */
function linearChannel(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(r, g, b) {
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  );
}

/** A small seeded generator, so the stars are the same on every run. */
function seeded(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The sky with the old panel, shield and text painted out: the region inside the four anchor
 * lines is a Coons patch of the pixels on those lines (each smoothed along its length), so it
 * is the aurora's own colours fading from side to side and top to bottom.
 */
async function cleanSky() {
  const { data } = await sharp(SKY)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = Uint8Array.from(data);
  const x0 = 86;
  const x1 = 1114;
  const y0 = 128;
  const y1 = 502;
  function at(x, y, c) {
    return px[(y * W + x) * 4 + c];
  }
  /** Each value replaced by the mean of its neighbours within `radius`. */
  function smooth(values, radius) {
    return values.map(function meanAround(_, i) {
      let sum = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j >= 0 && j < values.length) {
          sum += values[j];
          n++;
        }
      }
      return sum / n;
    });
  }
  function line(count, get) {
    return Array.from({ length: count }, function sample(_, i) {
      return get(i);
    });
  }
  const edges = [0, 1, 2].map((c) => ({
    top: smooth(
      line(x1 - x0 + 1, (i) => (at(x0 + i, y0, c) + at(x0 + i, y0 - 1, c)) / 2),
      9,
    ),
    bottom: smooth(
      line(x1 - x0 + 1, (i) => (at(x0 + i, y1, c) + at(x0 + i, y1 + 1, c)) / 2),
      9,
    ),
    left: smooth(
      line(y1 - y0 + 1, (j) => (at(x0, y0 + j, c) + at(x0 - 1, y0 + j, c)) / 2),
      9,
    ),
    right: smooth(
      line(y1 - y0 + 1, (j) => (at(x1, y0 + j, c) + at(x1 + 1, y0 + j, c)) / 2),
      9,
    ),
  }));
  for (let y = y0; y <= y1; y++) {
    const t = (y - y0) / (y1 - y0);
    for (let x = x0; x <= x1; x++) {
      const s = (x - x0) / (x1 - x0);
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const e = edges[c];
        const v =
          (1 - s) * e.left[y - y0] +
          s * e.right[y - y0] +
          (1 - t) * e.top[x - x0] +
          t * e.bottom[x - x0] -
          ((1 - s) * (1 - t) * e.left[0] +
            s * (1 - t) * e.right[0] +
            (1 - s) * t * e.left[y1 - y0] +
            s * t * e.right[y1 - y0]);
        px[i + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      px[i + 3] = 255;
    }
  }
  // A few stars where the old card's were painted out; the same each run.
  const random = seeded(20260511);
  for (let n = 0; n < 70; n++) {
    const x = Math.round(x0 + 4 + random() * (x1 - x0 - 8));
    const y = Math.round(y0 + 4 + random() * (y1 - y0 - 8));
    const power = 0.25 + random() * 0.55;
    for (let c = 0; c < 3; c++) {
      const i = (y * W + x) * 4 + c;
      px[i] = Math.round(px[i] + (ICE[c] - px[i]) * power);
    }
  }
  return px;
}

const CanvasKit = await CanvasKitInit({
  locateFile: (file) => require.resolve(`canvaskit-wasm/bin/full/${file}`),
});
const fontBytes = readFileSync(FONT);
const fontMgr = CanvasKit.FontMgr.FromData(
  fontBytes.buffer.slice(
    fontBytes.byteOffset,
    fontBytes.byteOffset + fontBytes.byteLength,
  ),
);
if (!fontMgr) throw new Error("cannot load Michroma");

function rgba(c, a = 1) {
  return CanvasKit.Color(c[0], c[1], c[2], a);
}

function paragraph(text, size, color) {
  const style = new CanvasKit.ParagraphStyle({
    textAlign: CanvasKit.TextAlign.Center,
    textStyle: {
      color: rgba(color),
      fontFamilies: ["Michroma"],
      fontSize: size,
      heightMultiplier: 1.2,
    },
  });
  const builder = CanvasKit.ParagraphBuilder.Make(style, fontMgr);
  builder.addText(text);
  const built = builder.build();
  builder.delete();
  built.layout(2000);
  return built;
}

/** The largest whole size at which `text` is no wider than `width`. */
function fitSize(text, width, max, min) {
  for (let size = max; size >= min; size--) {
    const built = paragraph(text, size, ICE);
    const w = built.getLongestLine();
    built.delete();
    if (w <= width) return size;
  }
  throw new Error(`"${text}" does not fit ${width}px`);
}

const wordmarkSize = fitSize(WORDMARK, TEXT_WIDTH, 120, 40);
const lineSize = fitSize(LINE, TEXT_WIDTH, 40, 14);

function measure(text, size) {
  const built = paragraph(text, size, ICE);
  const out = {
    width: built.getLongestLine(),
    height: built.getHeight(),
  };
  built.delete();
  return out;
}
const wm = measure(WORDMARK, wordmarkSize);
const ln = measure(LINE, lineSize);
const shieldHeight = SHIELD_HEIGHT;
const shieldWidth = (SHIELD.w / SHIELD.h) * shieldHeight;
const block = shieldHeight + GAP_SHIELD + wm.height + GAP_LINE + ln.height;
const top = Math.round((H - 8 - block) / 2);
const shieldY = top;
const wordmarkY = shieldY + shieldHeight + GAP_SHIELD;
const lineY = wordmarkY + wm.height + GAP_LINE;
const panelY = top - 34;
const panelH = block + 68;

const sky = await cleanSky();
const skyImage = CanvasKit.MakeImage(
  {
    width: W,
    height: H,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  },
  sky,
  W * 4,
);
const surface = CanvasKit.MakeSurface(W, H);
const canvas = surface.getCanvas();
canvas.drawImage(skyImage, 0, 0);

// The glass panel the column sits on, as .gmt-glass in @northguild/theme draws it: a dark
// wash, a faint cyan edge, a hairline that glints on the top-left and bottom-right edges, and
// a soft highlight along the top. Four straight sides and four 45-degree cuts; no arcs.
const panelRight = PANEL.x + PANEL.w;
const panelBottom = panelY + panelH;
const panel = CanvasKit.Path.MakeFromSVGString(
  [
    `M${PANEL.x + CHAMFER} ${panelY}`,
    `L${panelRight - CHAMFER} ${panelY}`,
    `L${panelRight} ${panelY + CHAMFER}`,
    `L${panelRight} ${panelBottom - CHAMFER}`,
    `L${panelRight - CHAMFER} ${panelBottom}`,
    `L${PANEL.x + CHAMFER} ${panelBottom}`,
    `L${PANEL.x} ${panelBottom - CHAMFER}`,
    `L${PANEL.x} ${panelY + CHAMFER}`,
    "Z",
  ].join(" "),
);
const wash = new CanvasKit.Paint();
wash.setAntiAlias(true);
wash.setColor(rgba(VOID, 0.55));
canvas.drawPath(panel, wash);
const edge = new CanvasKit.Paint();
edge.setAntiAlias(true);
edge.setStyle(CanvasKit.PaintStyle.Stroke);
edge.setStrokeWidth(PANEL_LINE);
edge.setStrokeJoin(CanvasKit.StrokeJoin.Miter);
edge.setColor(rgba(CYAN, 0.18));
canvas.drawPath(panel, edge);
// The hairline: CSS's 135deg gradient runs corner to corner of the box.
const reach = ((PANEL.w + panelH) * Math.SQRT1_2) / 2;
const midX = PANEL.x + PANEL.w / 2;
const midY = panelY + panelH / 2;
const glint = new CanvasKit.Paint();
glint.setAntiAlias(true);
glint.setStyle(CanvasKit.PaintStyle.Stroke);
glint.setStrokeWidth(PANEL_LINE);
glint.setStrokeJoin(CanvasKit.StrokeJoin.Miter);
glint.setShader(
  CanvasKit.Shader.MakeLinearGradient(
    [midX - reach * Math.SQRT1_2, midY - reach * Math.SQRT1_2],
    [midX + reach * Math.SQRT1_2, midY + reach * Math.SQRT1_2],
    [rgba(CYAN, 0.42), rgba(CYAN, 0), rgba(CYAN, 0), rgba(CYAN, 0.42)],
    [0, 0.4, 0.6, 1],
    CanvasKit.TileMode.Clamp,
  ),
);
canvas.drawPath(panel, glint);
const highlight = new CanvasKit.Paint();
highlight.setShader(
  CanvasKit.Shader.MakeLinearGradient(
    [PANEL.x + CHAMFER, 0],
    [panelRight - CHAMFER, 0],
    [rgba(ICE, 0), rgba(ICE, 0.08), rgba(ICE, 0.08), rgba(ICE, 0)],
    [0, 0.3, 0.7, 1],
    CanvasKit.TileMode.Clamp,
  ),
);
canvas.drawRect(
  CanvasKit.XYWHRect(PANEL.x + CHAMFER, panelY + 1, PANEL.w - 2 * CHAMFER, 1),
  highlight,
);

// Brightest pixel behind each text box, read after the panel and before the text.
function readBack() {
  return canvas.readPixels(0, 0, {
    width: W,
    height: H,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
}
const behind = readBack();
function worstContrast(box, color) {
  let max = 0;
  for (let y = Math.floor(box.y); y < Math.ceil(box.y + box.height); y++) {
    for (let x = Math.floor(box.x); x < Math.ceil(box.x + box.width); x++) {
      const i = (y * W + x) * 4;
      max = Math.max(max, luminance(behind[i], behind[i + 1], behind[i + 2]));
    }
  }
  return (luminance(...color) + 0.05) / (max + 0.05);
}
const wordmarkBox = {
  x: CENTER - wm.width / 2,
  y: wordmarkY,
  width: wm.width,
  height: wm.height,
};
const lineBox = {
  x: CENTER - ln.width / 2,
  y: lineY,
  width: ln.width,
  height: ln.height,
};
const contrast = {
  wordmark: worstContrast(wordmarkBox, ICE),
  line: worstContrast(lineBox, ICE_DIM),
};

// Shield.
canvas.save();
canvas.translate(CENTER - shieldWidth / 2, shieldY);
canvas.scale(shieldWidth / SHIELD.w, shieldHeight / SHIELD.h);
function path(d) {
  return CanvasKit.Path.MakeFromSVGString(d);
}
function fill(d, shader, alpha = 1) {
  const p = new CanvasKit.Paint();
  p.setAntiAlias(true);
  p.setShader(shader);
  p.setAlphaf(alpha);
  const shape = path(d);
  canvas.drawPath(shape, p);
  shape.delete();
  p.delete();
}
function gradient(c, from, to, x2, y2) {
  return CanvasKit.Shader.MakeLinearGradient(
    [0, 0],
    [x2, y2],
    [rgba(c, from), rgba(c, to)],
    [0, 1],
    CanvasKit.TileMode.Clamp,
  );
}
fill(SHIELD.outline, gradient(ICE, 0.2, 0.03, 0, SHIELD.h));
fill(SHIELD.lit, gradient(ICE, 0.14, 0, SHIELD.w * 0.7, SHIELD.h * 0.7));
fill(SHIELD.field, gradient(ICE, 0.2, 0.03, 0, SHIELD.h));
// Hairlines are one device pixel, so divide by the scale.
function stroke(d, color, alpha, widthPx, cap = true) {
  const p = new CanvasKit.Paint();
  p.setAntiAlias(true);
  p.setStyle(CanvasKit.PaintStyle.Stroke);
  p.setStrokeWidth(widthPx);
  p.setStrokeJoin(CanvasKit.StrokeJoin.Round);
  if (cap) p.setStrokeCap(CanvasKit.StrokeCap.Round);
  p.setColor(rgba(color, alpha));
  const shape = path(d);
  canvas.drawPath(shape, p);
  shape.delete();
  p.delete();
}
const unit = SHIELD.w / shieldWidth;
stroke(SHIELD.outline, ICE, 0.85, 2.2 * unit);
stroke(SHIELD.ridge, CYAN, 0.9, 2.2 * unit);
stroke(SHIELD.glyph, ICE, 0.95, 36);
canvas.restore();

// Text.
const wordmarkText = paragraph(WORDMARK, wordmarkSize, ICE);
canvas.drawParagraph(wordmarkText, CENTER - 1000, wordmarkY);
const lineText = paragraph(LINE, lineSize, ICE_DIM);
canvas.drawParagraph(lineText, CENTER - 1000, lineY);
wordmarkText.delete();
lineText.delete();

const pixels = Uint8Array.from(readBack());
surface.dispose();

const png = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } })
  .removeAlpha()
  .png({
    palette: true,
    quality: 100,
    effort: 1,
    dither: 0,
    compressionLevel: 9,
  })
  .toBuffer();
// Check before writing, so a failing card never replaces the good one.
if (contrast.wordmark < 4.5 || contrast.line < 4.5) {
  throw new Error(
    `a text falls below 4.5:1 (wordmark ${contrast.wordmark.toFixed(2)}, line ${contrast.line.toFixed(2)}); nothing written`,
  );
}
writeFileSync(OUT_SITE, png);
writeFileSync(OUT_UPLOAD, png);

console.log(`wrote ${OUT_SITE} and ${OUT_UPLOAD} (${png.length} bytes)`);
console.log(
  `wordmark ${wordmarkSize}px, ${wm.width.toFixed(0)} wide; line ${lineSize}px, ${ln.width.toFixed(0)} wide`,
);
console.log(
  `column y ${shieldY}..${Math.round(lineY + ln.height)}, panel x ${PANEL.x}..${PANEL.x + PANEL.w}`,
);
console.log(
  `contrast: wordmark ${contrast.wordmark.toFixed(2)}, line ${contrast.line.toFixed(2)}`,
);
