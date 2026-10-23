// Aurora background: the real night sky over Ísafjörður, in a Web Worker on
// an OffscreenCanvas so the page's main thread does no WebGL work at all.
// Passes per frame:
// 1. Footprint: each curtain's ground track and brightness into a small
//    texture (see aurora.shaders.ts).
// 2. Sky: a fullscreen march through the aurora in perspective, plus the moon
//    and, when it is up, the sun and its ice halos.
// 3. Stars from the Bright Star Catalogue and the planets, then the sparks,
//    added on top.
// 4. The mountain skyline, drawn last so it hides everything behind it.
// The page sends the theme token values, sizes and visibility; we answer "on"
// once a frame is up and "off" if we give up.

import {
  FOOT_FS,
  MAP_H,
  MAP_W,
  POINT_FS,
  QUAD_VS,
  RIDGE_FS,
  RIDGE_VS,
  SPARK_VS,
  STAR_VS,
  skyFs,
} from "./aurora.shaders";
import { getSystemTimeZone, getUnixNow } from "@northguild/gmt";
import { MOON } from "./aurora.moon";
import { SITES } from "./aurora.sites";
import {
  PLANETS,
  apply,
  columns,
  sky,
  type Sky,
  type Vec3,
} from "./aurora.sky";
import { SKYLINE as HELSINKI } from "./skylines/helsinki";
import { SKYLINE as ISAFJORDUR } from "./skylines/isafjordur";

const FRAME_MS = 1000 / 30;
const BASE_SCALE = 0.6;
const MAX_EDGE = 1280;
const SPARKS = 4000;
const RAD = Math.PI / 180;

// Wall-clock epoch milliseconds from Temporal (via gmt): the stars, planets,
// moon and sun need the real time. Frame timing uses rAF stamps, not the wall
// clock.
let wallMs = 0;
const wall = () => (wallMs = getUnixNow() ?? wallMs);

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
    }
  | { type: "site"; site: number }
  | { type: "size"; width: number; height: number }
  | { type: "still"; still: boolean }
  | { type: "hidden"; hidden: boolean }
  /** What is drawn near this point (CSS pixels), within reach pixels. */
  | { type: "pick"; x: number; y: number; reach: number };

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
 * or the answer to a pick (for the tooltips). */
export type WorkerMessage =
  | "on"
  | "off"
  | { site: number }
  | { pick: SkyLabel | null };

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

const nextFrame =
  "requestAnimationFrame" in self
    ? requestAnimationFrame
    : (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), FRAME_MS);
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

const bytes = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Ridge strip: for each azimuth, the ridge direction, then the far shore
 * over water or a direction far below the frame. */
function ridgeMesh(skyline: Skyline): Float32Array {
  const elev = new Int16Array(bytes(skyline.elev).buffer);
  const dist = new Uint16Array(bytes(skyline.dist).buffer);
  const base = new Int16Array(bytes(skyline.base).buffer);
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

function start(init: Extract<AuroraMessage, { type: "init" }>): void {
  const { canvas } = init;
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl || gl.getParameter(gl.MAX_TEXTURE_SIZE) < MAP_W) return;
  const foot = compile(gl, QUAD_VS, FOOT_FS);
  let skyProgram = compile(gl, QUAD_VS, skyFs(20, 320));
  const sparks = compile(gl, SPARK_VS, POINT_FS);
  const stars = compile(gl, STAR_VS, POINT_FS);
  const ridge = compile(gl, RIDGE_VS, RIDGE_FS);
  if (!foot || !skyProgram || !sparks || !stars || !ridge) return;

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
  const params = (filter: number, wrapS: number) => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  params(gl.NEAREST, gl.CLAMP_TO_EDGE);
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
    bytes(MOON.data),
  );
  params(gl.LINEAR, gl.REPEAT);
  gl.activeTexture(gl.TEXTURE0);

  const buffer = (data: Float32Array) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  };
  const tri = buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
  const seeds = buffer(Float32Array.from({ length: SPARKS * 4 }, Math.random));
  const ridgeBuf = gl.createBuffer();
  let ridgeCount = 0;
  const planetBuf = gl.createBuffer();
  let starBuf: WebGLBuffer | null = null;
  let starCount = 0;
  let starsAt = 0;

  // Uniforms that never change: colours and samplers.
  const setup = (program: WebGLProgram) => {
    gl.useProgram(program);
    for (const [name, rgb] of Object.entries(colours)) {
      const loc = gl.getUniformLocation(program, name);
      if (loc && rgb) gl.uniform3fv(loc, rgb);
    }
    gl.uniform1i(gl.getUniformLocation(program, "uMap"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uMoonTex"), 1);
  };
  for (const p of [foot, skyProgram, sparks, stars, ridge]) setup(p);
  const at = (program: WebGLProgram, name: string) =>
    gl.getUniformLocation(program, name);

  const attrib = (
    program: WebGLProgram,
    name: string,
    buf: WebGLBuffer | null,
    size: number,
    stride = 0,
    offset = 0,
  ) => {
    const a = gl.getAttribLocation(program, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, size, gl.FLOAT, false, stride, offset);
    return a;
  };

  // Everything that depends on where the viewer stands.
  let site = SITES[0]!;
  let tilt = [0, 0];
  // Ridge elevation by azimuth (degrees), radians; what is below it is hidden.
  let ridgeAt = (_az: number) => -Math.PI / 2;
  let cam = new Float32Array(9);
  let tanY = 1;
  // Camera basis as columns (right, up, forward), heading from north. On a
  // portrait screen the page's cards cover the middle, so the view widens and
  // tilts until the horizon sits about a third of the way down: the aurora then
  // shows above the cards and the land or water below them.
  const aim = () => {
    const aspect = (width || 1) / (height || 1);
    const portrait = Math.min(1, Math.max(0, (1 - aspect) / 0.45));
    const fov = (site.fov + 15 * portrait) * RAD;
    tanY = Math.tan(fov / 2);
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
    cam = new Float32Array([
      ...right,
      fwd[1] * right[2] - fwd[2] * right[1],
      fwd[2] * right[0] - fwd[0] * right[2],
      fwd[0] * right[1] - fwd[1] * right[0],
      ...fwd,
    ]);
  };
  const place = (index: number) => {
    site = SITES[index] ?? SITES[0]!;
    // Field lines climb toward magnetic south at the site's dip.
    const south = (180 + site.decl) * RAD;
    const lean = 1 / Math.tan(site.dip * RAD);
    tilt = [lean * Math.sin(south), lean * Math.cos(south)];
    aim();
    const skyline = SKYLINES[site.id];
    const mesh = skyline ? ridgeMesh(skyline) : new Float32Array(0);
    if (skyline) {
      const elev = new Int16Array(bytes(skyline.elev).buffer);
      ridgeAt = (az) =>
        ((elev[Math.round((az - skyline.from) / skyline.step)] ?? -9000) /
          100) *
        RAD;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, ridgeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    ridgeCount = mesh.length / 4;
  };
  let width = init.width;
  let height = init.height;
  place(init.site < 0 ? siteForTimeZone() : init.site);
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
  let skyAt = wall();
  let now: Sky = sky(site, skyAt);
  let planetsAt = 0;

  const resize = () => {
    const w = width || 1;
    const h = height || 1;
    const scale =
      Math.min(BASE_SCALE, MAX_EDGE / Math.max(w, h)) * (level ? 0.7 : 1);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    aim();
  };

  // What the page's pointer is over: the nearest sun, moon, planet or
  // star within reach that is up, clear of the skyline, bright enough to be
  // drawn and in frame.
  let starDirs: Float32Array | null = null;
  let named: StarName[] = [];
  // Constellation stick figures by name, as star index pairs.
  let figures: Record<string, number[]> = {};
  // A direction to CSS pixels, or null behind the camera.
  const screen = (d: Vec3): [number, number] | null => {
    const w = width || 1;
    const h = height || 1;
    const z = d[0] * cam[6]! + d[1] * cam[7]! + d[2] * cam[8]!;
    if (z <= 0) return null;
    const nx =
      (d[0] * cam[0]! + d[1] * cam[1]! + d[2] * cam[2]!) / (z * tanY * (w / h));
    const ny = (d[0] * cam[3]! + d[1] * cam[4]! + d[2] * cam[5]!) / (z * tanY);
    return [((nx + 1) / 2) * w, ((1 - ny) / 2) * h];
  };
  // Up and clear of the skyline.
  const clear = (d: Vec3, above: number) => {
    const alt = Math.asin(d[1]);
    return alt >= above && alt >= ridgeAt(Math.atan2(d[0], d[2]) / RAD);
  };
  const starAt = (i: number): Vec3 => {
    const s = starDirs!;
    return apply(now.stars, [s[i * 5]!, s[i * 5 + 1]!, s[i * 5 + 2]!]);
  };
  // A figure's lines, counted out from the hovered star or the figure's star
  // nearest it (parts it does not reach follow on), stopping short of each
  // star and cut wherever they pass below the horizon or behind the mountains.
  const figureLines = (pairs: number[], star: number): SkyLine[] => {
    let from = star;
    if (!pairs.includes(star)) {
      const s = starAt(star);
      let near = -2;
      for (const i of pairs) {
        const d = starAt(i);
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
      const [da, db] = [starAt(a), starAt(b)];
      const cos = da[0] * db[0] + da[1] * db[1] + da[2] * db[2];
      const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
      if (angle <= 2 * gap) continue;
      // Along the great circle in steps of at most half a degree.
      const n = Math.max(2, Math.ceil((angle - 2 * gap) / (0.5 * RAD)));
      let run: number[] = [];
      const end = () => {
        if (run.length >= 4) out.push({ step: step.get(a)!, points: run });
        run = [];
      };
      for (let i = 0; i <= n; i++) {
        const f = gap + ((angle - 2 * gap) * i) / n;
        const [ka, kb] = [Math.sin(angle - f), Math.sin(f)];
        const s = Math.sin(angle);
        const d: Vec3 = [
          (ka * da[0] + kb * db[0]) / s,
          (ka * da[1] + kb * db[1]) / s,
          (ka * da[2] + kb * db[2]) / s,
        ];
        const xy = clear(d, 0) ? screen(d) : null;
        if (!xy) {
          end();
          continue;
        }
        run.push(Math.round(xy[0] * 10) / 10, Math.round(xy[1] * 10) / 10);
      }
      end();
    }
    return out;
  };
  const pick = (px: number, py: number, reach: number): SkyLabel | null => {
    const w = width || 1;
    const h = height || 1;
    const limit = site.limit - 2 * now.moonlight;
    let best: SkyLabel | null = null;
    let bestStar = -1;
    let bestFigure = "";
    let nearest = reach * reach;
    const consider = (
      name: string,
      note: string,
      d: Vec3,
      above: number,
      star = -1,
      figure = "",
    ) => {
      if (!clear(d, above)) return;
      const xy = screen(d);
      if (!xy) return;
      const [x, y] = xy;
      if (x < 0 || x > w || y < 0 || y > h) return;
      const dist = (x - px) ** 2 + (y - py) ** 2;
      if (dist >= nearest) return;
      nearest = dist;
      bestStar = star;
      bestFigure = figure;
      best = { name, note, x: Math.round(x), y: Math.round(y) };
    };
    // Fainter near the horizon, as the star shader draws it.
    const seen = (mag: number, d: Vec3) =>
      mag + 0.12 * (1 / (Math.max(d[1], 0) + 0.04) - 1) < limit;
    consider("Sun", "", now.sun, -0.83 * RAD);
    consider("Moon", "", now.moon, 0);
    const p = now.planets;
    PLANETS.forEach((name, k) => {
      const d = apply(now.stars, [p[k * 5]!, p[k * 5 + 1]!, p[k * 5 + 2]!]);
      if (seen(p[k * 5 + 3]!, d)) consider(name, "Planet", d, 0);
    });
    const s = starDirs;
    if (s) {
      for (const [i, name, constellation = "", quiet] of named) {
        const d = starAt(i);
        if (!seen(s[i * 5 + 3]!, d)) continue;
        const note = quiet === 0 ? "" : constellation;
        consider(name, note, d, 0, i, constellation);
      }
    }
    const found = best as SkyLabel | null;
    const pairs = found && bestStar >= 0 ? figures[bestFigure] : undefined;
    if (!found || !pairs) return found;
    return {
      ...found,
      figure: bestFigure,
      lines: figureLines(pairs, bestStar),
    };
  };

  const quad = (program: WebGLProgram) => {
    const a = attrib(program, "aPos", tri, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(a);
  };

  const draw = () => {
    // The real sky turns slowly; refresh it once a second.
    if (wall() - skyAt > 1000) {
      skyAt = wallMs;
      now = sky(site, skyAt);
      planetsAt = 0;
    }
    if (!planetsAt) {
      planetsAt = skyAt;
      gl.bindBuffer(gl.ARRAY_BUFFER, planetBuf);
      gl.bufferData(gl.ARRAY_BUFFER, now.planets, gl.DYNAMIC_DRAW);
    }
    const tan = [tanY * (canvas.width / canvas.height), tanY];
    const px = Math.max(1, canvas.height / 540);
    const view = (program: WebGLProgram) => {
      gl.useProgram(program);
      gl.uniformMatrix3fv(at(program, "uCam"), false, cam);
      gl.uniform2fv(at(program, "uTan"), tan);
      gl.uniform1f(at(program, "uT"), t);
      gl.uniform1f(at(program, "uPx"), px);
      gl.uniform1f(at(program, "uMoonlight"), now.moonlight);
      gl.uniform2fv(at(program, "uTilt"), tilt);
      gl.uniform1f(at(program, "uGlow"), site.glow);
      gl.uniform1f(at(program, "uLights"), site.lights);
      for (const [name, c] of [
        ["uC0", site.curtains[0]],
        ["uC1", site.curtains[1]],
      ] as const) {
        gl.uniform3f(at(program, name), c.base, c.centre, c.half);
      }
    };

    // 1. Footprint.
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, MAP_W, MAP_H);
    view(foot);
    quad(foot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    // 2. Sky and moon.
    const sp = skyProgram;
    if (!sp) return;
    view(sp);
    gl.uniform1f(at(sp, "uPxAng"), (2 * tanY) / canvas.height);
    gl.uniform4f(at(sp, "uMoon"), ...now.moon, now.moonRadius);
    gl.uniform3fv(at(sp, "uMoonN"), now.moonNorth);
    gl.uniform3fv(at(sp, "uSun"), now.sun);
    gl.uniform2f(at(sp, "uSunDisc"), now.sunRadius, now.sunVisible);
    gl.uniform3fv(at(sp, "uShadow"), now.shadow);
    gl.uniform2f(at(sp, "uShadowR"), now.umbra, now.penumbra);
    quad(sp);

    // 3. Stars and sparks, added on top.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    view(stars);
    gl.uniformMatrix3fv(at(stars, "uStars"), false, columns(now.stars));
    gl.uniform1f(at(stars, "uLimit"), site.limit - 2 * now.moonlight);
    const points = (
      buf: WebGLBuffer | null,
      count: number,
      fade: number,
      steady: number,
    ) => {
      gl.uniform1f(at(stars, "uFade"), fade);
      gl.uniform1f(at(stars, "uSteady"), steady);
      const a = attrib(stars, "aDir", buf, 3, 20, 0);
      const b = attrib(stars, "aMag", buf, 2, 20, 12);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disableVertexAttribArray(a);
      gl.disableVertexAttribArray(b);
    };
    if (starBuf && starCount) {
      points(
        starBuf,
        starCount,
        Math.min(1, (performance.now() - starsAt) / 1500),
        0,
      );
    }
    points(planetBuf, now.planets.length / 5, 1, 1);
    view(sparks);
    const s = attrib(sparks, "aSeed", seeds, 4);
    gl.drawArrays(gl.POINTS, 0, sparkCount);
    gl.disableVertexAttribArray(s);

    // 4. Mountains over everything.
    gl.disable(gl.BLEND);
    view(ridge);
    const r = attrib(ridge, "aRidge", ridgeBuf, 4);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, ridgeCount);
    gl.disableVertexAttribArray(r);
  };

  const stop = () => {
    cancelFrame(raf);
    raf = 0;
  };

  const giveUp = () => {
    stop();
    level = 3;
    scope.postMessage("off");
  };

  // If frames run long, step quality down; past the last level give up and
  // leave the page's CSS gradient showing.
  const adapt = (elapsed: number) => {
    if (!tuning || elapsed > 250) return;
    total += elapsed;
    if (++samples < 45) return;
    const slow = total / samples > 45;
    samples = 0;
    total = 0;
    if (!slow) {
      tuning = false;
    } else if (++level === 1) {
      const lighter = compile(gl, QUAD_VS, skyFs(12, 260));
      if (lighter) {
        setup(lighter);
        skyProgram = lighter;
      }
      resize();
    } else if (level === 2) {
      sparkCount = SPARKS / 2;
    } else {
      giveUp();
    }
  };

  const frame = (stamp: number) => {
    raf = nextFrame(frame);
    const elapsed = stamp - last;
    if (elapsed < FRAME_MS - 2) return;
    if (last) {
      t += Math.min(elapsed, 100) / 1000;
      adapt(elapsed);
    }
    last = stamp;
    draw();
  };

  const run = () => {
    if (raf || level > 2 || still || hidden) return;
    last = 0;
    raf = nextFrame(frame);
  };

  canvas.addEventListener("webglcontextlost", giveUp);
  resize();
  draw();
  scope.postMessage("on");
  run();

  // Stars arrive after the first frame so they never delay it, then the star
  // names for the tooltips. Without them the aurora still runs.
  fetch(new URL("/stars.bin", self.location.origin))
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(res.status)))
    .then((buf) => {
      if (level > 2) return;
      const data = starData(buf);
      starDirs = data;
      starBuf = buffer(data);
      starCount = data.length / 5;
      starsAt = still ? -Infinity : performance.now();
      if (!raf) draw();
      return fetch(new URL("/star-names.json", self.location.origin));
    })
    .then((res) => (res?.ok ? res.json() : []))
    .then((list: StarName[]) => {
      named = list;
      return fetch(new URL("/constellations.json", self.location.origin));
    })
    .then((res) => (res.ok ? res.json() : {}))
    .then((list: Record<string, number[]>) => (figures = list))
    .catch(() => {});

  scope.onmessage = ({ data }) => {
    if (level > 2) return;
    if (data.type === "site") {
      place(data.site);
      skyAt = wall();
      now = sky(site, skyAt);
      planetsAt = 0;
      draw();
      scope.postMessage("on");
    } else if (data.type === "size") {
      width = data.width;
      height = data.height;
      resize();
      draw();
    } else if (data.type === "still") {
      still = data.still;
      stop();
      draw();
      run();
    } else if (data.type === "hidden") {
      hidden = data.hidden;
      if (hidden) stop();
      else run();
    } else if (data.type === "pick") {
      scope.postMessage({ pick: pick(data.x, data.y, data.reach) });
    }
  };
}

scope.onmessage = ({ data }) => {
  if (data.type === "init") start(data);
};
