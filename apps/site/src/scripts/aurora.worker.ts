// Aurora background: the real night sky over Ísafjörður, in a Web Worker on
// an OffscreenCanvas so the page's main thread does no WebGL work at all.
// Passes per frame:
// 1. Footprint: each curtain's ground track and brightness into a small
//    texture (see aurora.shaders.ts).
// 2. Sky: a fullscreen march through the aurora in perspective, plus the moon
//    and, when it is up, the sun and its ice halos.
// 3. Stars from the Bright Star Catalogue and the planets, then the sparks,
//    added on top.
// 4. The mountain skyline, which hides everything behind it.
// 5. Now and then a raven, nearer than anything else (see aurora.raven.ts).
// The page sends the theme token values, sizes and visibility; we answer "on"
// once a frame is up and "off" if we give up.

import {
  FOOT_FS,
  MAP_H,
  MAP_W,
  POINT_FS,
  QUAD_VS,
  RAVEN_BLIT_FS,
  RAVEN_BLIT_VS,
  RAVEN_FS,
  RAVEN_VS,
  RIDGE_FS,
  RIDGE_VS,
  SPARK_VS,
  STAR_VS,
  skyFragmentShader,
} from "./aurora.shaders";
import { getSystemTimeZone, getUnixNow } from "@northguild/gmt";
import { SUN_UP, lookAhead, type Seer, type SiteTimes } from "./aurora.ahead";
import { MOON } from "./aurora.moon";
import {
  RAVEN_STRIDE,
  RAVEN_TIMING,
  raven,
  type ScreenBox,
} from "./aurora.raven";
import { SITES, type Site } from "./aurora.sites";
import {
  PLANETS,
  apply,
  lift,
  matrixColumns,
  sky,
  type Sky,
  type Vec3,
} from "./aurora.sky";
import { SKYLINE as HELSINKI } from "./skylines/helsinki";
import { SKYLINE as ISAFJORDUR } from "./skylines/isafjordur";

const FRAME_MS = 1000 / 30;
/** During the fly-in, when he is close and crossing the screen fast. */
const FLY_IN_FRAME_MS = 1000 / 60;
const BASE_SCALE = 0.6;
const MAX_EDGE = 1280;
const SPARKS = 4000;
const RAD = Math.PI / 180;
/** The raven's own texture, square: big enough that scaling it down to the
 * bird's size on screen smooths its edges. */
const RAVEN_TEX = 512;

/** The shortest and longest sweep that draws a page box in, seconds. */
const BRUSH_QUICKEST = 0.6;
const BRUSH_LONGEST = 1;
/** Seconds after the first card that the second always starts. His flight
 * does not cross the second card soon enough to start it himself. */
const SECOND_CARD_FOLLOWS = 0.6;

// Wall-clock epoch milliseconds from Temporal (via gmt): the stars, planets,
// moon and sun need the real time. Frame timing uses rAF stamps, not the wall
// clock.
let wallMs = 0;
function readWallClock(): number {
  return (wallMs = getUnixNow() ?? wallMs);
}

type Rgb = [number, number, number];
type Skyline = typeof ISAFJORDUR;

// Skylines by site id (see scripts/build-skyline.mjs).
const SKYLINES: Record<string, Skyline> = {
  isafjordur: ISAFJORDUR,
  helsinki: HELSINKI,
};

export type AuroraMessage =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      colours: string[];
      /** Index into SITES, or -1 to pick from the browser's time zone. */
      site: number;
      still: boolean;
      hidden: boolean;
      /** The page's header, cards, title and intro, to draw in as the
       * fly-in reaches them, in CSS pixels: left, top, width, height. Later
       * fly-ins aim at them too. Empty when the page draws them in itself. */
      targets: PageBox[];
    }
  | { type: "site"; site: number }
  | { type: "size"; width: number; height: number; targets: PageBox[] }
  | { type: "still"; still: boolean }
  | { type: "hidden"; hidden: boolean }
  /** What is drawn near this point (CSS pixels), within reach pixels. */
  | { type: "pick"; x: number; y: number; reach: number }
  /** The page no longer shows the last pick; stop following it. */
  | { type: "drop" }
  /** Whether the page wants the sun and moon times (the popover is open or
   * about to be). */
  | { type: "times"; want: boolean };

/** A box on the page in CSS pixels: left, top, width, height. */
export type PageBox = [number, number, number, number];

/** One unbroken run of a constellation line in CSS pixels, [x, y, x, y, …],
 * drawn from the end nearer the hovered star; step counts lines out from it. */
export type SkyLine = { step: number; points: number[] };

/** The sun, moon, a planet or a star as drawn, in CSS pixels from the
 * canvas's corner; note is "Planet", a named star's constellation, or empty
 * when the name already says it ("ζ Herculis"). A star in a constellation
 * also brings its stick figure as it shows now: in front of the mountains and
 * above the horizon. */
export type SkyLabel = {
  name: string;
  note: string;
  x: number;
  y: number;
  figure?: string;
  lines?: SkyLine[];
};

/** A star's label (see scripts/build-stars.mjs): record index, name or
 * designation, constellation, and 0 if the name already says it. */
type StarName = [number, string, string?, 0?];

/** To the page: the frame is up ("on"), we gave up ("off"), the site drawn,
 * or the answer to a pick (for the tooltips). The picked object is then
 * followed: after a resize and as the sky turns, it comes again where the
 * object is now, or null once it is no longer drawn. */
export type WorkerMessage =
  | "on"
  | "off"
  | { site: number }
  | { pick: SkyLabel | null }
  /** Paint in the page's box `brush` (an index into the init's targets) now,
   * sweeping toward `angle` (a CSS gradient angle) over `duration` seconds;
   * -1 paints them all in, as there will be no fly-in. */
  | { brush: number; angle?: number; duration?: number }
  /** When the sun and moon next show in this window, per site in SITES order. */
  | { times: SiteTimes[]; zone: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AuroraMessage>) => void) | null;
  postMessage(message: WorkerMessage): void;
};

/** The site for this browser's time zone (via gmt), else one at random. */
function siteForTimeZone(): number {
  const zone = getSystemTimeZone();
  const match = SITES.findIndex((s) => s.zones.includes(zone));
  return match >= 0 ? match : Math.floor(Math.random() * SITES.length);
}

/** A frame on a timer, where the worker has no requestAnimationFrame. */
function nextFrameByTimer(cb: FrameRequestCallback): number {
  return setTimeout(() => cb(performance.now()), FRAME_MS);
}

const nextFrame =
  "requestAnimationFrame" in self ? requestAnimationFrame : nextFrameByTimer;
const cancelFrame =
  "cancelAnimationFrame" in self ? cancelAnimationFrame : clearTimeout;

function parseColours(values: string[]): Rgb[] {
  const ctx = new OffscreenCanvas(1, 1).getContext("2d", {
    willReadFrequently: true,
  });
  return values.map((value) => {
    if (!ctx) return [0, 0, 0];
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return [r / 255, g / 255, b / 255];
  });
}

function compile(
  gl: WebGLRenderingContext,
  vs: string,
  fs: string,
): WebGLProgram | null {
  const program = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  if (import.meta.env.DEV) {
    for (const shader of gl.getAttachedShaders(program) ?? []) {
      console.warn("aurora:", gl.getShaderInfoLog(shader));
    }
  }
  return null;
}

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Ridge strip: for each azimuth, the ridge direction, then the far shore
 * over water or a direction far below the frame. */
function ridgeMesh(skyline: Skyline): Float32Array {
  const elev = new Int16Array(decodeBase64(skyline.elev).buffer);
  const dist = new Uint16Array(decodeBase64(skyline.dist).buffer);
  const base = new Int16Array(decodeBase64(skyline.base).buffer);
  const out = new Float32Array(elev.length * 8);
  elev.forEach((e, i) => {
    const az = (skyline.from + i * skyline.step) * RAD;
    // 0 within 1 km of the viewer, rising to 1 at 31 km: paler, and lit if a city.
    const haze = Math.min(1, Math.max(0, ((dist[i] ?? 0) / 100 - 1) / 30));
    for (const [j, el] of [
      [0, (e / 100) * RAD],
      [1, ((base[i] ?? -4000) / 100) * RAD],
    ] as const) {
      out.set(
        [
          Math.sin(az) * Math.cos(el),
          Math.sin(el),
          Math.cos(az) * Math.cos(el),
          j ? -1 - haze : haze,
        ],
        i * 8 + j * 4,
      );
    }
  });
  return out;
}

/** Catalogue records (see scripts/build-stars.mjs) to direction + magnitude. */
function starData(buf: ArrayBuffer): Float32Array {
  const view = new DataView(buf);
  const n = Math.floor(buf.byteLength / 6);
  const out = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) {
    const ra = (view.getUint16(i * 6, true) / 65536) * 2 * Math.PI;
    const dec = (view.getInt16(i * 6 + 2, true) / 32767) * (Math.PI / 2);
    out.set(
      [
        Math.cos(dec) * Math.cos(ra),
        Math.cos(dec) * Math.sin(ra),
        Math.sin(dec),
        view.getUint8(i * 6 + 4) / 20 - 2,
        view.getInt8(i * 6 + 5) / 50,
      ],
      i * 5,
    );
  }
  return out;
}

/** Camera basis as columns (right, up, forward), heading from north, the
 * tangent of half the vertical field of view, and how far the screen counts
 * as portrait (0 landscape, 1 most phones). On a portrait screen the
 * page's cards cover the middle, so the view widens and tilts until the
 * horizon sits about a third of the way down: the aurora then shows above
 * the cards and the land or water below them. */
function camera(
  site: Site,
  width: number,
  height: number,
): { cam: Float32Array; tanY: number; portrait: number } {
  const aspect = (width || 1) / (height || 1);
  const portrait = Math.min(1, Math.max(0, (1 - aspect) / 0.45));
  const fov = (site.fov + 15 * portrait) * RAD;
  const tanY = Math.tan(fov / 2);
  const landscape =
    -Math.tan(site.pitch * RAD) / Math.tan((site.fov / 2) * RAD);
  const horizon = landscape + (0.3 - landscape) * portrait;
  const pitch = Math.atan(-horizon * tanY);
  const yaw = site.heading * RAD;
  const fwd = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ] as const;
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)] as const;
  const cam = new Float32Array([
    ...right,
    fwd[1] * right[2] - fwd[2] * right[1],
    fwd[2] * right[0] - fwd[0] * right[2],
    fwd[0] * right[1] - fwd[1] * right[0],
    ...fwd,
  ]);
  return { cam, tanY, portrait };
}

/** A direction to CSS pixels on a width × height screen, or null behind the
 * camera. */
function project(
  view: { cam: Float32Array; tanY: number },
  width: number,
  height: number,
  d: Vec3,
): [number, number] | null {
  const { cam, tanY } = view;
  const w = width || 1;
  const h = height || 1;
  const z = d[0] * cam[6]! + d[1] * cam[7]! + d[2] * cam[8]!;
  if (z <= 0) return null;
  const nx =
    (d[0] * cam[0]! + d[1] * cam[1]! + d[2] * cam[2]!) / (z * tanY * (w / h));
  const ny = (d[0] * cam[3]! + d[1] * cam[4]! + d[2] * cam[5]!) / (z * tanY);
  return [((nx + 1) / 2) * w, ((1 - ny) / 2) * h];
}

/** Ridge elevation by azimuth (degrees), radians; what is below it is
 * hidden. Straight between samples, as the ridge mesh is drawn. */
function ridgeFor(site: Site): (az: number) => number {
  const skyline = SKYLINES[site.id];
  if (!skyline) return () => -Math.PI / 2;
  const elev = new Int16Array(decodeBase64(skyline.elev).buffer);
  return (az) => {
    const x = (az - skyline.from) / skyline.step;
    const i = Math.floor(x);
    const a = elev[i] ?? elev[i + 1] ?? -9000;
    const b = elev[i + 1] ?? a;
    return ((a + (b - a) * (x - i)) / 100) * RAD;
  };
}

// The 22° halo's radius, and the sun's height (its y) above which the pillar
// is drawn at less than half strength: sun() in aurora.shaders.ts scales it
// by 1 - smoothstep(0.03, 0.11, y), which is 0.5 at y = 0.07 (about 4°).
const HALO = 0.384;
const PILLAR_TOP = 0.07;

/** Points around a circle of angular radius r about d (its centre too when
 * r is small enough to be a disc), as world directions. */
function ring(d: Vec3, r: number, n: number, centre: boolean): Vec3[] {
  // A basis across the line of sight: level, then up the sky.
  let e1: Vec3 = [d[2], 0, -d[0]];
  const l = Math.hypot(e1[0], e1[2]);
  e1 = l > 1e-9 ? [e1[0] / l, 0, e1[2] / l] : [1, 0, 0];
  const e2: Vec3 = [
    d[1] * e1[2] - d[2] * e1[1],
    d[2] * e1[0] - d[0] * e1[2],
    d[0] * e1[1] - d[1] * e1[0],
  ];
  const [c, s] = [Math.cos(r), Math.sin(r)];
  const out: Vec3[] = centre ? [d] : [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    const [u, v] = [Math.cos(t) * s, Math.sin(t) * s];
    out.push([
      d[0] * c + e1[0] * u + e2[0] * v,
      d[1] * c + e1[1] * u + e2[1] * v,
      d[2] * c + e1[2] * u + e2[2] * v,
    ]);
  }
  return out;
}

/** What a site's view shows on a width × height screen (see Seer). A point
 * shows when it is in frame and above the skyline the ridge mesh draws. */
function seer(site: Site, width: number, height: number): Seer {
  const [w, h] = [width || 1, height || 1];
  const view = camera(site, w, h);
  const ridge = ridgeFor(site);
  const fwd = [view.cam[6]!, view.cam[7]!, view.cam[8]!];
  // From the middle of the frame to its corner: nothing farther is in frame.
  const reach = Math.atan(Math.hypot(view.tanY * (w / h), view.tanY));
  function isShown(p: Vec3): boolean {
    if (Math.asin(p[1]) < ridge(Math.atan2(p[0], p[2]) / RAD)) return false;
    const xy = project(view, w, h, p);
    return !!xy && xy[0] >= 0 && xy[0] <= w && xy[1] >= 0 && xy[1] <= h;
  }
  // How far beyond `edge` of the frame's middle d is, and below `above`.
  function gapOutsideView(d: Vec3, edge: number, above: number): number {
    const cos = d[0] * fwd[0]! + d[1] * fwd[1]! + d[2] * fwd[2]!;
    const off = Math.acos(Math.min(1, Math.max(-1, cos)));
    return Math.max(off - reach - edge, above - Math.asin(d[1]));
  }
  return {
    disc: (d, r, above) => {
      const gap = gapOutsideView(d, r, above);
      if (gap > 0) return gap;
      // The centre and 16 points round the rim: a sliver counts.
      return ring(d, r, 16, true).some(isShown) ? 0 : 1e-6;
    },
    halo: (sun, r) => {
      const gap = gapOutsideView(sun, HALO, SUN_UP);
      if (gap > 0) return gap;
      // The ring is drawn too faintly to see on its own (and not at all over
      // the aurora), so it counts only beside the sun's own disc, and only
      // when a quarter of it shows (18 of 72 points, 5° apart round it).
      if (ring(sun, r, 16, true).some(isShown)) {
        let ringShows = 0;
        for (const p of ring(sun, HALO, 72, false)) {
          if (isShown(p) && ++ringShows >= 18) return 0;
        }
      }
      // The pillar, only where it is drawn at half strength or more, like
      // the sun: a sun below about 4°, and the 2° just above it (the shader
      // fades it by exp(-dAlt / 0.05), a half at 2°). At least 1° of that
      // must show: 2 of 4 points, half a degree apart.
      if (sun[1] >= PILLAR_TOP) return 1e-6;
      const alt = Math.asin(sun[1]);
      const az = Math.atan2(sun[0], sun[2]);
      let pillarShows = 0;
      for (let k = 1; k <= 4; k++) {
        const up = alt + k * 0.5 * RAD;
        const c = Math.cos(up);
        const p: Vec3 = [Math.sin(az) * c, Math.sin(up), Math.cos(az) * c];
        if (isShown(p) && ++pillarShows >= 2) return 0;
      }
      return 1e-6;
    },
  };
}

function start(init: Extract<AuroraMessage, { type: "init" }>): void {
  const { canvas } = init;
  const context = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!context || context.getParameter(context.MAX_TEXTURE_SIZE) < MAP_W) {
    return;
  }
  // Bound again so the named functions below see it as non-null: TypeScript
  // does not carry a null check into a function declaration.
  const gl: WebGLRenderingContext = context;
  const maybeFoot = compile(gl, QUAD_VS, FOOT_FS);
  let skyProgram = compile(gl, QUAD_VS, skyFragmentShader(20, 320));
  const maybeSparks = compile(gl, SPARK_VS, POINT_FS);
  const maybeStars = compile(gl, STAR_VS, POINT_FS);
  const maybeRidge = compile(gl, RIDGE_VS, RIDGE_FS);
  if (!maybeFoot || !skyProgram || !maybeSparks || !maybeStars || !maybeRidge) {
    return;
  }
  // Bound again as non-null, for the same reason as gl.
  const foot: WebGLProgram = maybeFoot;
  const sparks: WebGLProgram = maybeSparks;
  const stars: WebGLProgram = maybeStars;
  const ridge: WebGLProgram = maybeRidge;
  // Without these the sky still runs, just with no raven.
  const ravenProgram = compile(gl, RAVEN_VS, RAVEN_FS);
  const ravenBlit = compile(gl, RAVEN_BLIT_VS, RAVEN_BLIT_FS);

  const [voidC, spring, cyan, teal, purple, ice] = parseColours(init.colours);
  const colours: Record<string, Rgb | undefined> = {
    uVoid: voidC,
    uSpring: spring,
    uCyan: cyan,
    uTeal: teal,
    uPurple: purple,
    uIce: ice,
  };
  // Footprint texture and framebuffer on unit 0.
  const map = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, map);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    MAP_W,
    MAP_H,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  function setTextureParams(filter: number, wrapS: number): void {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  setTextureParams(gl.NEAREST, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    map,
    0,
  );
  const complete =
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) return;

  // Moon albedo on unit 1 (power-of-two, so it may repeat in longitude).
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.LUMINANCE,
    MOON.width,
    MOON.height,
    0,
    gl.LUMINANCE,
    gl.UNSIGNED_BYTE,
    decodeBase64(MOON.data),
  );
  setTextureParams(gl.LINEAR, gl.REPEAT);

  // The raven's texture on unit 2, mipmapped, with a depth buffer to draw it.
  gl.activeTexture(gl.TEXTURE2);
  const ravenTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, ravenTex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    RAVEN_TEX,
    RAVEN_TEX,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  setTextureParams(gl.LINEAR, gl.CLAMP_TO_EDGE);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  const ravenFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, ravenFbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    ravenTex,
    0,
  );
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(
    gl.RENDERBUFFER,
    gl.DEPTH_COMPONENT16,
    RAVEN_TEX,
    RAVEN_TEX,
  );
  gl.framebufferRenderbuffer(
    gl.FRAMEBUFFER,
    gl.DEPTH_ATTACHMENT,
    gl.RENDERBUFFER,
    depth,
  );
  const ravenOk =
    !!ravenProgram &&
    !!ravenBlit &&
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.activeTexture(gl.TEXTURE0);

  function createStaticBuffer(data: Float32Array) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }
  const tri = createStaticBuffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
  const square = createStaticBuffer(
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
  );
  const ravenBuf = gl.createBuffer();
  const seeds = createStaticBuffer(
    Float32Array.from({ length: SPARKS * 4 }, Math.random),
  );
  const ridgeBuf = gl.createBuffer();
  let ridgeCount = 0;
  const planetBuf = gl.createBuffer();
  let starBuf: WebGLBuffer | null = null;
  let starCount = 0;
  let starsAt = 0;

  // Uniforms that never change: colours and samplers.
  function setFixedUniforms(program: WebGLProgram): void {
    gl.useProgram(program);
    for (const [name, rgb] of Object.entries(colours)) {
      const loc = gl.getUniformLocation(program, name);
      if (loc && rgb) gl.uniform3fv(loc, rgb);
    }
    gl.uniform1i(gl.getUniformLocation(program, "uMap"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uMoonTex"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "uRaven"), 2);
  }
  for (const p of [foot, skyProgram, sparks, stars, ridge]) setFixedUniforms(p);
  if (ravenProgram && ravenBlit)
    for (const p of [ravenProgram, ravenBlit]) setFixedUniforms(p);
  function uniformLocation(
    program: WebGLProgram,
    name: string,
  ): WebGLUniformLocation | null {
    return gl.getUniformLocation(program, name);
  }

  function bindAttribute(
    program: WebGLProgram,
    name: string,
    buf: WebGLBuffer | null,
    size: number,
    stride = 0,
    offset = 0,
  ): number {
    const a = gl.getAttribLocation(program, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, size, gl.FLOAT, false, stride, offset);
    return a;
  }

  // Everything that depends on where the viewer stands.
  let site = SITES[0]!;
  let tilt = [0, 0];
  // Ridge elevation by azimuth (degrees), radians; what is below it is hidden.
  function flatRidge(_az: number): number {
    return -Math.PI / 2;
  }
  let ridgeAt: (az: number) => number = flatRidge;
  let cam: Float32Array = new Float32Array(9);
  let tanY = 1;
  let portrait = 0;
  function aimCamera(): void {
    ({ cam, tanY, portrait } = camera(site, width, height));
  }
  // The raven, planned in the view as it is when a flight starts.
  const bird = raven(RAVEN_TIMING);
  function currentRavenView() {
    return {
      cam,
      tanY,
      aspect: (width || 1) / (height || 1),
      eye: site.eye,
      ridge: ridgeAt,
      // Landscape: below the middle of the cards. Portrait: the cards sit
      // below the horizon, so up toward the top of the frame.
      ceiling: 0.3 + 0.55 * portrait,
      // Where the page's boxes are, for every fly-in, so the one after a
      // sky switch flies the same line as the first.
      targets: targets.map(onScreen),
    };
  }

  // The page's header, title, intro and cards, hidden until the fly-in
  // reaches them: his flight draws each one in. As he reaches a box the page
  // starts a quick sweep across it the way he is flying (its edge enters the
  // box a quarter of the way into the sweep and crosses it in the middle
  // half; see Base.astro). A box he has not reached is drawn in once he is
  // past its middle on his way down the screen (top left to bottom right). The
  // second card starts a fixed time after the first, so the two keep the same
  // timing against him on every load.
  let targets: PageBox[] = init.targets;
  let painted = targets.map(() => false);
  let seen: [number, number] | null = null;
  let heading: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
  // His speed across the screen, CSS pixels a second, and the seconds since
  // the first card started drawing in.
  let pace = 0;
  let sinceFirstCard = 0;
  /** A page box on screen, -1 to 1 with y up, as the raven plans in. */
  function onScreen([x, y, w, h]: PageBox): ScreenBox {
    const [W, H] = [width || 1, height || 1];
    return [
      (2 * x) / W - 1,
      1 - (2 * (y + h)) / H,
      (2 * (x + w)) / W - 1,
      1 - (2 * y) / H,
    ];
  }
  /** The box's corners along the heading: the nearest, and how far across. */
  function spanAlongHeading([x, y, w, h]: PageBox): [number, number] {
    const along = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ].map(([cx, cy]) => cx! * heading[0] + cy! * heading[1]);
    const lead = Math.min(...along);
    return [lead, Math.max(...along) - lead];
  }
  function paint(i: number): void {
    const [, span] = spanAlongHeading(targets[i]!);
    painted[i] = true;
    scope.postMessage({
      brush: i,
      angle: Math.round(
        (Math.atan2(heading[0], -heading[1]) / RAD + 360) % 360,
      ),
      // The sweep's edge crosses the box in the middle half of the sweep, at
      // about his pace where the limits allow. A large box or a slowing bird
      // hits BRUSH_LONGEST, and then the edge can overtake him.
      duration:
        Math.round(
          Math.min(
            BRUSH_LONGEST,
            Math.max(BRUSH_QUICKEST, (2 * span) / (0.7 * pace || 1)),
          ) * 100,
        ) / 100,
    });
  }
  function paintTheRest(): void {
    painted.forEach((done, i) => {
      if (!done) paint(i);
    });
  }
  function paintInWake(dt: number): void {
    if (!painted.includes(false)) return;
    if (!bird.entering) {
      // The fly-in is over and he never passed some: paint them now.
      if (seen) paintTheRest();
      return;
    }
    const at = project({ cam, tanY }, width, height, bird.position);
    if (!at) return;
    if (seen) {
      const [dx, dy] = [at[0] - seen[0], at[1] - seen[1]];
      const moved = Math.hypot(dx, dy);
      if (moved > 0.5 && dt > 0) {
        // Smoothed, so a wobble in the curve does not swing the wave.
        const hx = heading[0] * 0.6 + (dx / moved) * 0.4;
        const hy = heading[1] * 0.6 + (dy / moved) * 0.4;
        const n = Math.hypot(hx, hy) || 1;
        heading = [hx / n, hy / n];
        pace = moved / dt;
      }
    }
    seen = at;
    const [bx0, by0, bx1, by1] = birdOnPage();
    targets.forEach((box, i) => {
      if (painted[i]) return;
      const [x, y, w, h] = box;
      // His body reaching it, not just a wing tip: his middle within a
      // quarter of his size of the box. The header, a thin strip across the
      // top, he sweeps with a wing as he comes in: any of him will do.
      const [mx, my] =
        i === 0
          ? [(bx1 - bx0) / 2, (by1 - by0) / 2]
          : [(bx1 - bx0) / 4, (by1 - by0) / 4];
      const over =
        at[0] > x - mx &&
        at[0] < x + w + mx &&
        at[1] > y - my &&
        at[1] < y + h + my;
      // Along the screen's diagonal, which his swoop follows overall; his
      // heading at the moment can swing back as he turns.
      const [W, H] = [width || 1, height || 1];
      const past = at[0] * W + at[1] * H >= (x + w / 2) * W + (y + h / 2) * H;
      const follows =
        i === 2 && painted[1] && sinceFirstCard >= SECOND_CARD_FOLLOWS;
      if (over || past || follows) paint(i);
    });
    if (painted[1]) sinceFirstCard += dt;
  }
  /** The bird's extent on the page in CSS pixels: left, top, right, bottom. */
  function birdOnPage(): [number, number, number, number] {
    const m = bird.mesh;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < bird.count * RAVEN_STRIDE; i += RAVEN_STRIDE) {
      const xy = project({ cam, tanY }, width, height, [
        m[i]!,
        m[i + 1]!,
        m[i + 2]!,
      ]);
      if (!xy) continue;
      [x0, x1] = [Math.min(x0, xy[0]), Math.max(x1, xy[0])];
      [y0, y1] = [Math.min(y0, xy[1]), Math.max(y1, xy[1])];
    }
    return [x0, y0, x1, y1];
  }
  function moveToSite(index: number): void {
    site = SITES[index] ?? SITES[0]!;
    // Field lines climb toward magnetic south at the site's dip.
    const south = (180 + site.decl) * RAD;
    const lean = 1 / Math.tan(site.dip * RAD);
    tilt = [lean * Math.sin(south), lean * Math.cos(south)];
    aimCamera();
    const skyline = SKYLINES[site.id];
    const mesh = skyline ? ridgeMesh(skyline) : new Float32Array(0);
    ridgeAt = ridgeFor(site);
    gl.bindBuffer(gl.ARRAY_BUFFER, ridgeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    ridgeCount = mesh.length / 4;
  }
  let width = init.width;
  let height = init.height;
  moveToSite(init.site < 0 ? siteForTimeZone() : init.site);
  scope.postMessage({ site: SITES.indexOf(site) });

  // Quality levels: 0 full, 1 lower resolution and fewer sky steps, 2 also
  // half the sparks, 3 stopped.
  let level = 0;
  let sparkCount = SPARKS;
  let still = init.still;
  let hidden = init.hidden;
  let t = 120;
  let raf = 0;
  let last = 0;
  let samples = 0;
  let total = 0;
  let tuning = true;
  let skyAt = readWallClock();
  let now: Sky = sky(site, skyAt);
  let planetsAt = 0;

  function resizeCanvas(): void {
    const w = width || 1;
    const h = height || 1;
    const scale =
      Math.min(BASE_SCALE, MAX_EDGE / Math.max(w, h)) * (level ? 0.7 : 1);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    aimCamera();
  }

  // What the page's pointer is over: the nearest sun, moon, planet or
  // star within reach that is up, clear of the skyline, bright enough to be
  // drawn and in frame.
  let starDirs: Float32Array | null = null;
  let named: StarName[] = [];
  // Constellation stick figures by name, as star index pairs, and the
  // figure of each star in one (for stars whose label names none).
  let figures: Record<string, number[]> = {};
  const figureOf = new Map<number, string>();
  // A direction to CSS pixels, or null behind the camera.
  function toScreen(d: Vec3): [number, number] | null {
    return project({ cam, tanY }, width, height, d);
  }
  // Up and clear of the skyline.
  function isClearOfSkyline(d: Vec3, above: number): boolean {
    const alt = Math.asin(d[1]);
    return alt >= above && alt >= ridgeAt(Math.atan2(d[0], d[2]) / RAD);
  }
  // True direction, and where it is seen (lifted by refraction, as drawn).
  function trueStarDirection(i: number): Vec3 {
    const s = starDirs!;
    return apply(now.stars, [s[i * 5]!, s[i * 5 + 1]!, s[i * 5 + 2]!]);
  }
  function seenStarDirection(i: number): Vec3 {
    return lift(trueStarDirection(i));
  }
  // A figure's lines, counted out from the hovered star or the figure's star
  // nearest it (parts it does not reach follow on), stopping short of each
  // star and cut wherever they pass below the horizon or behind the mountains.
  function figureLines(pairs: number[], star: number): SkyLine[] {
    let from = star;
    if (!pairs.includes(star)) {
      const s = seenStarDirection(star);
      let near = -2;
      for (const i of pairs) {
        const d = seenStarDirection(i);
        const dot = d[0] * s[0] + d[1] * s[1] + d[2] * s[2];
        if (dot > near) [near, from] = [dot, i];
      }
    }
    const step = new Map<number, number>([[from, 0]]);
    let queue = [from];
    let next = 0;
    while (step.size < new Set(pairs).size) {
      if (!queue.length) {
        const rest = pairs.find((i) => !step.has(i))!;
        step.set(rest, ++next);
        queue = [rest];
      }
      const at = queue.shift()!;
      const n = step.get(at)!;
      next = Math.max(next, n);
      for (let k = 0; k < pairs.length; k += 2) {
        const [a, b] = [pairs[k]!, pairs[k + 1]!];
        const other = a === at ? b : b === at ? a : -1;
        if (other >= 0 && !step.has(other)) {
          step.set(other, n + 1);
          queue.push(other);
        }
      }
    }
    // 6 CSS pixels clear of each star, in radians at the middle of the view.
    const gap = (6 * 2 * tanY) / (height || 1);
    const out: SkyLine[] = [];
    for (let k = 0; k < pairs.length; k += 2) {
      let [a, b] = [pairs[k]!, pairs[k + 1]!];
      if (step.get(b)! < step.get(a)!) [a, b] = [b, a];
      // Along the true great circle, each point then lifted as drawn.
      const [da, db] = [trueStarDirection(a), trueStarDirection(b)];
      const cos = da[0] * db[0] + da[1] * db[1] + da[2] * db[2];
      const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
      if (angle <= 2 * gap) continue;
      // Along the great circle in steps of at most half a degree.
      const n = Math.max(2, Math.ceil((angle - 2 * gap) / (0.5 * RAD)));
      let run: number[] = [];
      function finishRun(): void {
        if (run.length >= 4) out.push({ step: step.get(a)!, points: run });
        run = [];
      }
      for (let i = 0; i <= n; i++) {
        const f = gap + ((angle - 2 * gap) * i) / n;
        const [ka, kb] = [Math.sin(angle - f), Math.sin(f)];
        const s = Math.sin(angle);
        const d = lift([
          (ka * da[0] + kb * db[0]) / s,
          (ka * da[1] + kb * db[1]) / s,
          (ka * da[2] + kb * db[2]) / s,
        ]);
        const xy = isClearOfSkyline(d, 0) ? toScreen(d) : null;
        if (!xy) {
          finishRun();
          continue;
        }
        run.push(Math.round(xy[0] * 10) / 10, Math.round(xy[1] * 10) / 10);
      }
      finishRun();
    }
    return out;
  }
  // What was last picked, to follow: a star's index, or SUN, LUNA or
  // PLANET - k for planet k (LUNA: MOON is the texture). NOTHING when
  // nothing is.
  const [NOTHING, SUN, LUNA, PLANET] = [-1, -2, -3, -4];
  let held = NOTHING;
  function seenPlanetDirection(k: number): Vec3 {
    const p = now.planets;
    return lift(apply(now.stars, [p[k * 5]!, p[k * 5 + 1]!, p[k * 5 + 2]!]));
  }
  function pickNear(px: number, py: number, reach: number): SkyLabel | null {
    const w = width || 1;
    const h = height || 1;
    const limit = site.limit - 2 * now.moonlight;
    let best: SkyLabel | null = null;
    let bestWhat = NOTHING;
    let bestFigure = "";
    let nearest = reach * reach;
    function consider(
      name: string,
      note: string,
      d: Vec3,
      above: number,
      what: number,
      figure = "",
    ): void {
      if (!isClearOfSkyline(d, above)) return;
      const xy = toScreen(d);
      if (!xy) return;
      const [x, y] = xy;
      if (x < 0 || x > w || y < 0 || y > h) return;
      const dist = (x - px) ** 2 + (y - py) ** 2;
      if (dist >= nearest) return;
      nearest = dist;
      bestWhat = what;
      bestFigure = figure;
      best = { name, note, x: Math.round(x), y: Math.round(y) };
    }
    // Fainter near the horizon, as the star shader draws it.
    function isBrightEnough(mag: number, d: Vec3): boolean {
      return mag + 0.12 * (1 / (Math.max(d[1], 0) + 0.04) - 1) < limit;
    }
    // Seen from its upper limb on the horizon (now.sun is lifted by refraction).
    consider("Sun", "", now.sun, -now.sunRadius, SUN);
    consider("Moon", "", now.moon, 0, LUNA);
    PLANETS.forEach((name, k) => {
      const d = seenPlanetDirection(k);
      if (isBrightEnough(now.planets[k * 5 + 3]!, d)) {
        consider(name, "Planet", d, 0, PLANET - k);
      }
    });
    const s = starDirs;
    if (s) {
      for (const [i, name, constellation = "", quiet] of named) {
        const d = seenStarDirection(i);
        if (!isBrightEnough(s[i * 5 + 3]!, d)) continue;
        const note = quiet === 0 ? "" : constellation;
        const figure = constellation || figureOf.get(i) || "";
        consider(name, note, d, 0, i, figure);
      }
    }
    held = bestWhat;
    const found = best as SkyLabel | null;
    const pairs = found && bestWhat >= 0 ? figures[bestFigure] : undefined;
    if (!found || !pairs) return found;
    return {
      ...found,
      figure: bestFigure,
      lines: figureLines(pairs, bestWhat),
    };
  }
  // Pick the held object again where it is drawn now.
  function followHeld(): void {
    if (held === NOTHING) return;
    const d =
      held >= 0
        ? seenStarDirection(held)
        : held === SUN
          ? now.sun
          : held === LUNA
            ? now.moon
            : seenPlanetDirection(PLANET - held);
    const xy = toScreen(d);
    scope.postMessage({ pick: xy ? pickNear(xy[0], xy[1], 1) : null });
    if (!xy) held = NOTHING;
  }

  // Sun and moon times, while the page wants them: worked out fresh from the
  // clock a slice at a time between frames, and again when a spell starts or
  // ends, after local midnight, at least hourly, when the window changes size
  // and when the tab is shown again (background timers can run late).
  let wantTimes = false;
  let timesRun = 0;
  let timesTimer = 0;
  function updateTimes(): void {
    clearTimeout(timesTimer);
    const run = ++timesRun;
    if (!wantTimes) return;
    const [w, h] = [width || 1, height || 1];
    const seers = SITES.map((s) => seer(s, w, h));
    const job = lookAhead(SITES, seers, readWallClock());
    function workOnTimes(): void {
      if (run !== timesRun) return;
      const step = job.next();
      if (!step.done) {
        timesTimer = self.setTimeout(workOnTimes, 0);
        return;
      }
      scope.postMessage({
        times: step.value.times,
        zone: getSystemTimeZone(),
      });
      timesTimer = self.setTimeout(
        updateTimes,
        Math.max(step.value.next - readWallClock(), 0) + 1000,
      );
    }
    workOnTimes();
  }

  function drawQuad(program: WebGLProgram): void {
    const a = bindAttribute(program, "aPos", tri, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(a);
  }

  function drawFrame(): void {
    // The real sky turns slowly; refresh it once a second.
    if (readWallClock() - skyAt > 1000) {
      skyAt = wallMs;
      now = sky(site, skyAt);
      planetsAt = 0;
      followHeld();
    }
    if (!planetsAt) {
      planetsAt = skyAt;
      gl.bindBuffer(gl.ARRAY_BUFFER, planetBuf);
      gl.bufferData(gl.ARRAY_BUFFER, now.planets, gl.DYNAMIC_DRAW);
    }
    const tan = [tanY * (canvas.width / canvas.height), tanY];
    const px = Math.max(1, canvas.height / 540);
    function setViewUniforms(program: WebGLProgram): void {
      gl.useProgram(program);
      gl.uniformMatrix3fv(uniformLocation(program, "uCam"), false, cam);
      gl.uniform2fv(uniformLocation(program, "uTan"), tan);
      gl.uniform1f(uniformLocation(program, "uT"), t);
      gl.uniform1f(uniformLocation(program, "uPx"), px);
      gl.uniform1f(uniformLocation(program, "uMoonlight"), now.moonlight);
      gl.uniform2fv(uniformLocation(program, "uTilt"), tilt);
      gl.uniform1f(uniformLocation(program, "uGlow"), site.glow);
      gl.uniform1f(uniformLocation(program, "uLights"), site.lights);
      for (const [name, c] of [
        ["uC0", site.curtains[0]],
        ["uC1", site.curtains[1]],
      ] as const) {
        gl.uniform3f(uniformLocation(program, name), c.base, c.centre, c.half);
      }
    }

    // 1. Footprint.
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, MAP_W, MAP_H);
    setViewUniforms(foot);
    drawQuad(foot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    // 2. Sky and moon.
    const sp = skyProgram;
    if (!sp) return;
    setViewUniforms(sp);
    gl.uniform1f(uniformLocation(sp, "uPxAng"), (2 * tanY) / canvas.height);
    gl.uniform4f(uniformLocation(sp, "uMoon"), ...now.moon, now.moonRadius);
    gl.uniform3fv(uniformLocation(sp, "uMoonN"), now.moonNorth);
    gl.uniform3fv(uniformLocation(sp, "uSun"), now.sun);
    gl.uniform2f(
      uniformLocation(sp, "uSunDisc"),
      now.sunRadius,
      now.sunVisible,
    );
    gl.uniform3fv(uniformLocation(sp, "uShadow"), now.shadow);
    gl.uniform2f(uniformLocation(sp, "uShadowR"), now.umbra, now.penumbra);
    drawQuad(sp);

    // 3. Stars and sparks, added on top.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    setViewUniforms(stars);
    gl.uniformMatrix3fv(
      uniformLocation(stars, "uStars"),
      false,
      matrixColumns(now.stars),
    );
    gl.uniform1f(
      uniformLocation(stars, "uLimit"),
      site.limit - 2 * now.moonlight,
    );
    function drawPoints(
      buf: WebGLBuffer | null,
      count: number,
      fade: number,
      steady: number,
    ): void {
      gl.uniform1f(uniformLocation(stars, "uFade"), fade);
      gl.uniform1f(uniformLocation(stars, "uSteady"), steady);
      const a = bindAttribute(stars, "aDir", buf, 3, 20, 0);
      const b = bindAttribute(stars, "aMag", buf, 2, 20, 12);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disableVertexAttribArray(a);
      gl.disableVertexAttribArray(b);
    }
    if (starBuf && starCount) {
      drawPoints(
        starBuf,
        starCount,
        Math.min(1, (performance.now() - starsAt) / 1500),
        0,
      );
    }
    drawPoints(planetBuf, now.planets.length / 5, 1, 1);
    setViewUniforms(sparks);
    const s = bindAttribute(sparks, "aSeed", seeds, 4);
    gl.drawArrays(gl.POINTS, 0, sparkCount);
    gl.disableVertexAttribArray(s);

    // 4. Mountains over everything.
    gl.disable(gl.BLEND);
    setViewUniforms(ridge);
    const r = bindAttribute(ridge, "aRidge", ridgeBuf, 4);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, ridgeCount);
    gl.disableVertexAttribArray(r);

    // 5. The raven, in front of everything.
    if (ravenOk && bird.count) drawRaven(setViewUniforms, tan);
  }

  // The raven into its texture with the camera cropped to it, then the
  // texture, scaled down, over the frame.
  function drawRaven(
    setViewUniforms: (program: WebGLProgram) => void,
    tan: number[],
  ): void {
    const [W, H] = [canvas.width, canvas.height];
    const m = bird.mesh;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    let [near, far] = [Infinity, 0];
    for (let i = 0; i < bird.count * RAVEN_STRIDE; i += RAVEN_STRIDE) {
      const [x, y, z] = [m[i]!, m[i + 1]!, m[i + 2]!];
      const cz = x * cam[6]! + y * cam[7]! + z * cam[8]!;
      if (cz < 0.5) return;
      const cx = (x * cam[0]! + y * cam[1]! + z * cam[2]!) / (cz * tan[0]!);
      const cy = (x * cam[3]! + y * cam[4]! + z * cam[5]!) / (cz * tan[1]!);
      [x0, x1] = [Math.min(x0, cx), Math.max(x1, cx)];
      [y0, y1] = [Math.min(y0, cy), Math.max(y1, cy)];
      [near, far] = [Math.min(near, cz), Math.max(far, cz)];
    }
    if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return;
    // A square crop in pixels, with a margin so the texture's edge is clear.
    const half = Math.max((x1 - x0) * W, (y1 - y0) * H) / 4 + 2;
    const rect = [
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      (2 * half) / W,
      (2 * half) / H,
    ] as const;
    [near, far] = [Math.max(0.1, near - 0.5), far + 0.5];
    const rp = ravenProgram!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, ravenFbo);
    gl.viewport(0, 0, RAVEN_TEX, RAVEN_TEX);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    setViewUniforms(rp);
    gl.uniform4f(uniformLocation(rp, "uCrop"), ...rect);
    gl.uniform2f(
      uniformLocation(rp, "uDepth"),
      (far + near) / (far - near),
      (2 * far * near) / (near - far),
    );
    gl.uniform4f(uniformLocation(rp, "uMoon"), ...now.moon, now.moonRadius);
    gl.bindBuffer(gl.ARRAY_BUFFER, ravenBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      m.subarray(0, bird.count * RAVEN_STRIDE),
      gl.DYNAMIC_DRAW,
    );
    const a = bindAttribute(rp, "aPos", ravenBuf, 3, 4 * RAVEN_STRIDE, 0);
    const b = bindAttribute(rp, "aNormal", ravenBuf, 3, 4 * RAVEN_STRIDE, 12);
    gl.drawArrays(gl.TRIANGLES, 0, bird.count);
    gl.disableVertexAttribArray(a);
    gl.disableVertexAttribArray(b);
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE2);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.activeTexture(gl.TEXTURE0);

    const bp = ravenBlit!;
    gl.useProgram(bp);
    gl.uniform4f(uniformLocation(bp, "uRect"), ...rect);
    gl.uniform1f(uniformLocation(bp, "uAlpha"), bird.alpha);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const q = bindAttribute(bp, "aPos", square, 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(q);
    gl.disable(gl.BLEND);
  }

  function stopLoop(): void {
    cancelFrame(raf);
    raf = 0;
  }

  function giveUp(): void {
    stopLoop();
    level = 3;
    scope.postMessage("off");
  }

  // If frames run long, step quality down; past the last level give up and
  // leave the page's CSS gradient showing.
  function adaptQuality(elapsed: number): void {
    if (!tuning || elapsed > 250) return;
    total += elapsed;
    if (++samples < 45) return;
    const slow = total / samples > 45;
    samples = 0;
    total = 0;
    if (!slow) {
      tuning = false;
    } else if (++level === 1) {
      const lighter = compile(gl, QUAD_VS, skyFragmentShader(12, 260));
      if (lighter) {
        setFixedUniforms(lighter);
        skyProgram = lighter;
      }
      resizeCanvas();
    } else if (level === 2) {
      sparkCount = SPARKS / 2;
    } else {
      giveUp();
    }
  }

  // Whether the fly-in can run at 60 fps here, and the time between its
  // frames lately (ms).
  let smooth = true;
  let paceMs = FLY_IN_FRAME_MS;
  function onFrame(stamp: number): void {
    raf = nextFrame(onFrame);
    const elapsed = stamp - last;
    // The fly-in at 60 fps while he is close and crossing the screen fast,
    // and only while frames keep up: an uneven 60 looks worse than a steady
    // 30.
    const fast = bird.entering && smooth && Math.hypot(...bird.position) < 15;
    if (elapsed < (fast ? FLY_IN_FRAME_MS : FRAME_MS) - 2) return;
    if (fast && last && elapsed < 200) {
      paceMs = paceMs * 0.9 + elapsed * 0.1;
      if (paceMs > 22) smooth = false;
    }
    if (last) {
      const dt = Math.min(elapsed, 100) / 1000;
      t += dt;
      bird.step(dt, currentRavenView());
      paintInWake(dt);
      adaptQuality(elapsed);
    }
    last = stamp;
    drawFrame();
  }

  function startLoop(): void {
    if (raf || level > 2 || still || hidden) return;
    last = 0;
    raf = nextFrame(onFrame);
  }

  canvas.addEventListener("webglcontextlost", giveUp);
  resizeCanvas();
  drawFrame();
  scope.postMessage("on");
  // No raven to draw, or no motion: the page paints its boxes in itself.
  if (targets.length && (!ravenOk || still)) {
    painted = painted.map(() => true);
    scope.postMessage({ brush: -1 });
  }
  startLoop();

  // Stars arrive after the first frame so they never delay it, then the star
  // names for the tooltips. Without them the aurora still runs.
  fetch(new URL("/stars.bin", self.location.origin))
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(res.status)))
    .then((buf) => {
      if (level > 2) return;
      const data = starData(buf);
      starDirs = data;
      starBuf = createStaticBuffer(data);
      starCount = data.length / 5;
      starsAt = still ? -Infinity : performance.now();
      if (!raf) drawFrame();
      return fetch(new URL("/star-names.json", self.location.origin));
    })
    .then((res) => (res?.ok ? res.json() : []))
    .then((list: StarName[]) => {
      named = list;
      return fetch(new URL("/constellations.json", self.location.origin));
    })
    .then((res) => (res.ok ? res.json() : {}))
    .then((list: Record<string, number[]>) => {
      figures = list;
      for (const [name, pairs] of Object.entries(list)) {
        for (const i of pairs) if (!figureOf.has(i)) figureOf.set(i, name);
      }
    })
    .catch(() => {});

  scope.onmessage = ({ data }) => {
    if (level > 2) return;
    if (data.type === "site") {
      held = NOTHING;
      // Anything not yet painted in comes in now; the new sky gets its own
      // fly-in once it is up.
      paintTheRest();
      if (still) bird.reset();
      else bird.enter(1);
      moveToSite(data.site);
      skyAt = readWallClock();
      now = sky(site, skyAt);
      planetsAt = 0;
      drawFrame();
      scope.postMessage("on");
    } else if (data.type === "size") {
      width = data.width;
      height = data.height;
      if (data.targets.length === targets.length) targets = data.targets;
      resizeCanvas();
      drawFrame();
      followHeld();
      updateTimes();
    } else if (data.type === "still") {
      still = data.still;
      // A raven held still in mid-air would look wrong: it waits instead.
      if (still) bird.reset();
      stopLoop();
      drawFrame();
      startLoop();
    } else if (data.type === "hidden") {
      hidden = data.hidden;
      if (hidden) stopLoop();
      else {
        startLoop();
        updateTimes();
      }
    } else if (data.type === "pick") {
      scope.postMessage({ pick: pickNear(data.x, data.y, data.reach) });
    } else if (data.type === "drop") {
      held = NOTHING;
    } else if (data.type === "times") {
      if (data.want === wantTimes) return;
      wantTimes = data.want;
      updateTimes();
    }
  };
}

scope.onmessage = ({ data }) => {
  if (data.type === "init") start(data);
};
