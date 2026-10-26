// Huginn: a raven that now and then flies across the view, through the same
// 3D world as the sky. Units: metres and seconds. World frame: x east, y up,
// z north, the viewer's eye at the origin.
//
// Each flight is planned in the camera's frame so that it crosses the window:
// usually a pass along a gentle curve 20 to 65 m away, sometimes a few lazy
// circles farther out, low over the horizon where the aurora lights the sky. The bird is a small mesh posed every frame. It flaps in
// bouts at about 3.4 beats a second, the hand folding back on the upstroke,
// and glides in between. It banks into its turns and now and then rolls onto
// its back for a moment, as ravens do. Proportions follow the common raven:
// about 64 cm long, a 1.2 m span, a heavy head and bill held well forward, a
// wedge-shaped tail and five fingered primaries at each wing tip.

type V = [number, number, number];

export type RavenView = {
  /** Camera basis as columns (right, up, forward), as camera() in the worker. */
  cam: Float32Array;
  /** Tangent of half the vertical field of view. */
  tanY: number;
  /** Width over height. */
  aspect: number;
  /** Eye height above the ground or sea, metres. */
  eye: number;
  /** Skyline elevation by azimuth (degrees), radians. */
  ridge: (az: number) => number;
  /** The highest a flight's middle goes on screen (-1 bottom, 1 top): clear
   * of the page's cards. */
  ceiling: number;
};

export type RavenTiming = {
  /** Seconds before the first flight. */
  first: [number, number];
  /** Seconds between flights. */
  gap: [number, number];
};

/** The first flight as the page opens, then a new one about 30 s after
 * each ends. */
export const RAVEN_TIMING: RavenTiming = { first: [0.5, 1.5], gap: [27, 33] };

const G = 9.81;
/** Metres over which the bird fades in at a flight's start and out at its
 * end: unseen when the ends are out of frame, as most are. */
const FADE = 12;
const RAD = Math.PI / 180;

const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: V): V => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const lerp = (a: V, b: V, k: number): V => add(a, mul(sub(b, a), k));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const rand = (lo: number, hi: number) => lo + (hi - lo) * Math.random();
const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

// ---------------------------------------------------------------------------
// The bird, in its own frame: x right, y up, z forward, metres, the centre of
// lift at the origin.

/** Body stations from the tail to the bill tip: z, centre height, half
 * width, half height. */
const BODY: [number, number, number, number][] = [
  [-0.15, 0.0, 0.04, 0.024],
  [-0.09, 0.0, 0.056, 0.04],
  [-0.02, -0.004, 0.066, 0.056],
  [0.05, 0.0, 0.062, 0.056],
  [0.11, 0.01, 0.04, 0.042],
  [0.16, 0.016, 0.038, 0.04],
  [0.2, 0.012, 0.03, 0.036],
  [0.245, 0.006, 0.014, 0.018],
  [0.28, -0.002, 0.003, 0.004],
];
const SIDES = 8;

/** One body station as a ring of points, in the bird's frame. */
function bodyRing(i: number): V[] {
  return Array.from({ length: SIDES }, (_, j): V => {
    const [z, y, rx, ry] = BODY[i]!;
    const a = (2 * Math.PI * j) / SIDES;
    return [rx * Math.cos(a), y + ry * Math.sin(a), z];
  });
}

/** The body's triangles, in the bird's frame. */
function bodyTriangles(): V[] {
  const out: V[] = [];
  const rings = BODY.map((_, i) => bodyRing(i));
  for (let i = 0; i + 1 < rings.length; i++) {
    const [r0, r1] = [rings[i]!, rings[i + 1]!];
    for (let j = 0; j < SIDES; j++) {
      const k = (j + 1) % SIDES;
      out.push(r0[j]!, r0[k]!, r1[j]!, r1[j]!, r0[k]!, r1[k]!);
    }
  }
  // Close the tail end (the tail itself hides most of it).
  const [z0, y0] = BODY[0]!;
  for (let j = 0; j < SIDES; j++) {
    out.push([0, y0, z0], rings[0]![(j + 1) % SIDES]!, rings[0]![j]!);
  }
  return out;
}

/** The body is rigid: its triangles are built once. */
const BODY_TRIS = bodyTriangles();

/** Right wing, flat: the arm from the shoulder to the wrist, then the hand.
 * x outward, z forward, at the height of the shoulder. */
const WING_Y = 0.02;
const SHOULDER: V = [0.045, WING_Y, 0];
const ARM: V[] = [
  [0.045, WING_Y, 0.06], // root, leading edge
  [0.045, WING_Y, -0.13], // root, trailing edge
  [0.17, WING_Y, 0.075],
  [0.17, WING_Y, -0.15], // the broad inner wing (secondaries)
  [0.29, WING_Y, 0.075], // wrist
  [0.29, WING_Y, -0.14],
];
const WRIST = ARM[4]!;
const HAND: V[] = [
  [0.46, WING_Y, 0.04], // leading edge where the fingers start
  [0.42, WING_Y, -0.11], // trailing edge where the fingers start
  [0.36, WING_Y, -0.14], // inner primaries
];
/** The five long primaries that stand apart at the tip, front to back:
 * where along the hand's outer edge they start, angle from straight out
 * (forward positive) and length. */
const FINGERS: [number, number, number][] = [
  [0.1, 6 * RAD, 0.125],
  [0.3, -4 * RAD, 0.15],
  [0.5, -14 * RAD, 0.15],
  [0.7, -24 * RAD, 0.135],
  [0.9, -34 * RAD, 0.11],
];
const FINGER_MEAN = -14 * RAD;

/** The tail, flat, as a fan from its root: a wedge, the middle feathers
 * longest. Right half from the root's edge to the middle tip. */
const TAIL_ROOT: V = [0, 0.004, -0.12];
const TAIL: [number, number][] = [
  [0.04, -0.12],
  [0.05, -0.22],
  [0.056, -0.27],
  [0.03, -0.32],
  [0, -0.35],
];

const TRIS =
  BODY_TRIS.length / 3 +
  2 * (4 + 3 + FINGERS.length * 3) +
  (TAIL.length - 1) * 2;
/** Floats per vertex: position, then the face normal. */
export const RAVEN_STRIDE = 6;

type Pose = {
  /** Arm raised (rad), and the hand raised further from it. */
  arm: number;
  hand: number;
  /** Arm and hand swept back (rad). */
  armBack: number;
  handBack: number;
  /** Arm span, 1 fully out, less with the elbow bent. */
  reach: number;
  /** How far the fingers fan, 1 as at rest. */
  spread: number;
  /** Wing tips bent up under load. */
  curl: number;
  /** How far the tail fans, 1 as at rest, and its tilt down (rad). */
  tail: number;
  tailDown: number;
};

const GLIDE: Pose = {
  arm: 0.08,
  hand: -0.05,
  armBack: 0,
  handBack: 0.12,
  reach: 1,
  spread: 1,
  curl: 1,
  tail: 1.1,
  tailDown: 0,
};
/** Circling on still air: wings out, fingers and tail spread wide. */
const SOAR: Pose = {
  arm: 0.14,
  hand: 0.03,
  armBack: -0.03,
  handBack: 0,
  reach: 1,
  spread: 1.35,
  curl: 1.4,
  tail: 1.6,
  tailDown: 0.05,
};
/** Diving or rolling: wings half closed. */
const TUCK: Pose = {
  arm: 0.05,
  hand: -0.1,
  armBack: 0.12,
  handBack: 0.6,
  reach: 0.88,
  spread: 0.6,
  curl: 0.3,
  tail: 0.85,
  tailDown: -0.03,
};

const blend = (a: Pose, b: Pose, k: number): Pose => ({
  arm: mix(a.arm, b.arm, k),
  hand: mix(a.hand, b.hand, k),
  armBack: mix(a.armBack, b.armBack, k),
  handBack: mix(a.handBack, b.handBack, k),
  reach: mix(a.reach, b.reach, k),
  spread: mix(a.spread, b.spread, k),
  curl: mix(a.curl, b.curl, k),
  tail: mix(a.tail, b.tail, k),
  tailDown: mix(a.tailDown, b.tailDown, k),
});

// One wingbeat from the top: the downstroke takes a little over half of it,
// the wing fully out and the tip bending up under load; on the upstroke the
// wrist bends, the hand sweeps back and the tip trails.
const DOWN = 0.55;
const TOP = 0.75;
const BOTTOM = -0.65;
/** Where in the beat the wing passes the glide pose, going down. */
const LEVEL_PHASE = 0.26;

function beat(p: number): Pose {
  const down = p < DOWN;
  const x = down ? p / DOWN : (p - DOWN) / (1 - DOWN);
  const ease = (1 - Math.cos(Math.PI * x)) / 2;
  const bump = Math.sin(Math.PI * x);
  const fold = down ? 0 : bump;
  return {
    arm: down ? mix(TOP, BOTTOM, ease) : mix(BOTTOM, TOP, ease),
    hand: down ? 0.3 * bump : -0.4 * bump,
    armBack: down ? -0.12 * bump : 0.2 * fold,
    handBack: 0.95 * fold,
    reach: 1 - 0.2 * fold,
    spread: 1 - 0.6 * fold,
    curl: down ? 0.6 + 0.8 * bump : 0.3,
    tail: 1,
    tailDown: 0,
  };
}

/** Raise by a about the forward axis (positive lifts a right-hand point). */
const raise = (v: V, a: number): V => {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
};
/** Sweep back by a about the up axis (positive moves a right-hand point
 * toward the tail). */
const sweep = (v: V, a: number): V => {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
};

/** The right wing's triangles for a pose, in the bird's frame. */
function wing(pose: Pose, out: V[]): void {
  const armTurn = (v: V) => raise(sweep(v, pose.armBack), pose.arm);
  const armPoint = (v: V): V => {
    const q = sub(v, SHOULDER);
    return add(SHOULDER, armTurn([q[0] * pose.reach, q[1], q[2]]));
  };
  const wrist = armPoint(WRIST);
  // A point given relative to the wrist, in the hand's flat frame.
  const handPoint = (q: V): V =>
    add(wrist, armTurn(raise(sweep(q, pose.handBack), pose.hand)));
  const a = ARM.map(armPoint);
  const h = HAND.map((v) => handPoint(sub(v, WRIST)));
  out.push(a[0]!, a[1]!, a[2]!, a[2]!, a[1]!, a[3]!);
  out.push(a[2]!, a[3]!, a[4]!, a[4]!, a[3]!, a[5]!);
  out.push(a[4]!, h[0]!, h[1]!, a[4]!, h[1]!, h[2]!, a[4]!, h[2]!, a[5]!);
  const [e0, e1] = [sub(HAND[0]!, WRIST), sub(HAND[1]!, WRIST)];
  for (const [at, angle, length] of FINGERS) {
    const phi = FINGER_MEAN + (angle - FINGER_MEAN) * pose.spread;
    const d: V = [Math.cos(phi), 0, Math.sin(phi)];
    const n: V = [-Math.sin(phi), 0, Math.cos(phi)];
    // Start a little inside the hand so the finger overlaps it.
    const base = sub(lerp(e0, e1, at), mul(d, 0.035));
    const up = (f: number): V => [0, pose.curl * 0.03 * f * f, 0];
    const p = (along: number, across: number) =>
      handPoint(
        add(add(base, add(mul(d, along), mul(n, across))), up(along / length)),
      );
    const [b0, b1] = [p(0, 0.013), p(0, -0.013)];
    const [t0, t1] = [p(length, 0.0055), p(length, -0.0055)];
    const tip = p(length + 0.012, 0);
    out.push(b0, b1, t0, t0, b1, t1, t0, t1, tip);
  }
}

/** The tail's triangles for a pose, in the bird's frame. */
function tail(pose: Pose, out: V[]): void {
  const [c, s] = [Math.cos(pose.tailDown), Math.sin(pose.tailDown)];
  const point = (x: number, z: number): V => {
    const dz = z - TAIL_ROOT[2];
    return [x * pose.tail, TAIL_ROOT[1] - dz * s, TAIL_ROOT[2] + dz * c];
  };
  const root = point(0, TAIL_ROOT[2]);
  for (const side of [1, -1]) {
    for (let i = 0; i + 1 < TAIL.length; i++) {
      const [x0, z0] = TAIL[i]!;
      const [x1, z1] = TAIL[i + 1]!;
      out.push(root, point(side * x0, z0), point(side * x1, z1));
    }
  }
}

// ---------------------------------------------------------------------------
// Flight paths.

type Path = {
  /** Points along the curve, and the distance flown to each. */
  points: V[];
  dist: number[];
  length: number;
  /** Airspeed, m/s. */
  speed: number;
  soar: boolean;
  /** Distance along the path at which to roll over, or -1 for none. */
  rollAt: number;
};

/** Centripetal Catmull–Rom through p1 and p2, at t from 0 to 1. */
function catmull(p0: V, p1: V, p2: V, p3: V, t: number): V {
  const knot = (a: V, b: V) =>
    Math.max(Math.sqrt(Math.hypot(...sub(b, a))), 1e-4);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const a1 = lerp(p0, p1, u / t1);
  const a2 = lerp(p1, p2, (u - t1) / (t2 - t1));
  const a3 = lerp(p2, p3, (u - t2) / (t3 - t2));
  const b1 = lerp(a1, a2, u / t2);
  const b2 = lerp(a2, a3, (u - t1) / (t3 - t1));
  return lerp(b1, b2, (u - t1) / (t2 - t1));
}

function curve(through: V[], speed: number, soar: boolean, roll: number): Path {
  const n = through.length;
  const at = (i: number): V =>
    i < 0
      ? sub(mul(through[0]!, 2), through[1]!)
      : i >= n
        ? sub(mul(through[n - 1]!, 2), through[n - 2]!)
        : through[i]!;
  const points: V[] = [];
  for (let i = 0; i + 1 < n; i++) {
    for (let k = 0; k < 40; k++) {
      points.push(catmull(at(i - 1), at(i), at(i + 1), at(i + 2), k / 40));
    }
  }
  points.push(through[n - 1]!);
  const dist = [0];
  for (let i = 1; i < points.length; i++) {
    dist.push(dist[i - 1]! + Math.hypot(...sub(points[i]!, points[i - 1]!)));
  }
  const length = dist[dist.length - 1]!;
  const rollAt = Math.random() < roll ? length * rand(0.35, 0.6) : -1;
  return { points, dist, length, speed, soar, rollAt };
}

/** Where along the path, by distance flown. */
function along(path: Path, s: number): V {
  const { points, dist } = path;
  const c = Math.min(Math.max(s, 0), path.length);
  let [lo, hi] = [0, dist.length - 1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! <= c) lo = mid;
    else hi = mid;
  }
  const span = dist[hi]! - dist[lo]! || 1;
  return lerp(points[lo]!, points[hi]!, (c - dist[lo]!) / span);
}

/** The view's axes, and whether a point is within the frame (with a margin). */
function frame(view: RavenView) {
  const c = view.cam;
  const right: V = [c[0]!, c[1]!, c[2]!];
  const up: V = [c[3]!, c[4]!, c[5]!];
  const fwd: V = [c[6]!, c[7]!, c[8]!];
  const tanX = view.tanY * view.aspect;
  const inside = (p: V, margin = 1.1) => {
    const z = dot(p, fwd);
    if (z < 1) return false;
    return (
      Math.abs(dot(p, right) / (z * tanX)) < margin &&
      Math.abs(dot(p, up) / (z * view.tanY)) < margin
    );
  };
  const ray = (nx: number, ny: number) =>
    unit(add(fwd, add(mul(right, nx * tanX), mul(up, ny * view.tanY))));
  // Where the horizon straight ahead crosses the screen (-1 bottom, 1 top).
  const level = unit([fwd[0], 0, fwd[2]]);
  const horizon = dot(level, up) / (dot(level, fwd) * view.tanY);
  // A height on screen from lo to hi above the horizon, kept clear of the
  // page's cards: the band where the aurora and a city's glow light the sky
  // from behind, so the black bird shows against them.
  const low = (lo: number, hi: number) =>
    rand(
      horizon + lo,
      Math.max(horizon + lo, Math.min(horizon + hi, view.ceiling)),
    );
  return { right, up, fwd, inside, ray, low };
}

/** The least height above the ground or sea, metres. */
const GROUND = 4;

/** Clear of the ground and seen against the sky rather than the skyline. */
function skyward(p: V, view: RavenView): boolean {
  if (p[1] < GROUND - view.eye) return false;
  const el = Math.asin(p[1] / Math.hypot(...p));
  return el > view.ridge(Math.atan2(p[0], p[2]) / RAD) + 1.2 * RAD;
}

/** From p along d until just out of frame, or 100 m on, whichever is
 * first: a path that runs nearly along the line of sight would otherwise
 * start or end hundreds of metres off, the bird a dot for many seconds.
 * The planners prefer paths that do leave the frame; the bird fades in and
 * out at the ends of those that do not (see FADE). */
function leave(p: V, d: V, inside: (p: V) => boolean): V {
  for (let s = 0; s < 100; s += 2) {
    const q = add(p, mul(d, s));
    if (!inside(q)) return add(q, mul(d, 6));
  }
  return add(p, mul(d, 100));
}

const keepUp = (p: V, view: RavenView): V => [
  p[0],
  Math.max(p[1], GROUND - view.eye),
  p[2],
];

/** A pass across the view along a gentle curve. */
function pass(view: RavenView): Path | null {
  const { fwd, inside, ray, low } = frame(view);
  const yaw = Math.atan2(fwd[0], fwd[2]);
  const ahead: V = [Math.sin(yaw), 0, Math.cos(yaw)];
  const across: V = [Math.cos(yaw), 0, -Math.sin(yaw)];
  // A path whose ends are still in frame, in case no other turns up.
  let spare: Path | null = null;
  for (let tries = 0; tries < 16; tries++) {
    // 20 to 65 m away, more often near the nearer end.
    const d = 20 + 45 * Math.random() ** 1.5;
    const mid = mul(ray(rand(-0.5, 0.5), low(0.06, 0.6)), d);
    if (!skyward(mid, view)) continue;
    const side = Math.random() < 0.5 ? -1 : 1;
    const flat = unit(add(mul(across, side), mul(ahead, rand(-0.55, 0.55))));
    const dir = unit([flat[0], rand(-0.06, 0.1), flat[2]]);
    const a = leave(mid, mul(dir, -1), inside);
    const b = leave(mid, dir, inside);
    const length = Math.hypot(...sub(b, a));
    const aside = unit([-dir[2], 0, dir[0]]);
    const bend = (p: V) =>
      keepUp(
        add(
          p,
          add(mul(aside, rand(-0.08, 0.08) * length), [0, rand(-3, 3), 0]),
        ),
        view,
      );
    const through = [
      keepUp(a, view),
      bend(lerp(a, mid, 0.5)),
      mid,
      bend(lerp(mid, b, 0.5)),
      keepUp(b, view),
    ];
    const path = curve(through, rand(10, 12.5), false, 0.25);
    if (!inside(a) && !inside(b)) return path;
    spare ??= path;
  }
  return spare;
}

/** A few slow circles on still air, then away. */
function circles(view: RavenView): Path | null {
  const { inside, ray, low } = frame(view);
  for (let tries = 0; tries < 16; tries++) {
    const centre = mul(ray(rand(-0.35, 0.35), low(0.15, 0.55)), rand(50, 90));
    const r = rand(12, 22);
    const turns = rand(1.25, 2.5);
    const sense = Math.random() < 0.5 ? -1 : 1;
    const climb = rand(-4, 4);
    const start = rand(0, 2 * Math.PI);
    const steps = Math.ceil(turns * 12);
    const ring: V[] = [];
    for (let k = 0; k <= steps; k++) {
      const a = start + (sense * k * Math.PI) / 6;
      ring.push(
        add(centre, [r * Math.cos(a), (climb * k) / 12, r * Math.sin(a)]),
      );
    }
    if (!ring.every((p) => skyward(p, view) && inside(p, 0.95))) continue;
    // Join and leave the circle where the tangent leaves the frame soonest,
    // within its first and last turn, keeping at least three quarters of a
    // turn between: a tangent pointing away from the camera can stay in
    // frame for far longer than the 100 m leave() goes.
    const tangent = (k: number) => unit(sub(ring[k + 1]!, ring[k]!));
    const out = (k: number, d: V) => {
      const p = leave(ring[k]!, d, inside);
      return {
        k,
        p,
        s: Math.hypot(...sub(p, ring[k]!)) + (inside(p) ? 1e3 : 0),
      };
    };
    const soonest = (list: ReturnType<typeof out>[]) =>
      list.reduce((best, o) => (o.s < best.s ? o : best));
    const first = soonest(
      Array.from({ length: Math.min(12, steps - 9) }, (_, k) =>
        out(k, mul(tangent(k), -1)),
      ),
    );
    const last = soonest(
      Array.from({ length: Math.min(12, steps - first.k - 8) }, (_, i) =>
        out(steps - i, tangent(steps - i - 1)),
      ),
    );
    return curve(
      [
        keepUp(first.p, view),
        ...ring.slice(first.k, last.k + 1),
        keepUp(last.p, view),
      ],
      rand(8.5, 10),
      true,
      0.12,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------

export type Raven = {
  /** Fly on by dt seconds, planning a new flight in this view when one is
   * due. */
  step(dt: number, view: RavenView): void;
  /** Land: no bird until the next flight is due, after `wait` seconds (a
   * fresh gap if not given). */
  reset(wait?: number): void;
  /** The bird's triangles in world space (RAVEN_STRIDE floats a vertex). */
  mesh: Float32Array;
  /** Vertices to draw, 0 when there is no bird. */
  count: number;
  /** How much of the bird shows, fading in and out at a flight's ends. */
  alpha: number;
};

export function raven(timing: RavenTiming = RAVEN_TIMING): Raven {
  const mesh = new Float32Array(TRIS * 3 * RAVEN_STRIDE);
  let wait = rand(...timing.first);
  let path: Path | null = null;
  let s = 0;
  let size = 1;
  let rate = 3.4;
  // Flapping: the beat's phase, how far into it the pose is (eased), whether
  // the bird wants to flap and for how much longer.
  let phase = LEVEL_PHASE;
  let flap = 0;
  let flapTarget = 0;
  let wantFlap = true;
  let bout = 0;
  // Roll: seconds since it started, or -1.
  let rolled = false;
  let rollT = -1;
  let up: V | null = null;

  const bird: Raven = {
    mesh,
    count: 0,
    alpha: 0,
    reset(next) {
      path = null;
      bird.count = 0;
      wait = next ?? rand(...timing.gap);
    },
    step(dt, view) {
      if (!path) {
        wait -= dt;
        if (wait > 0) return;
        path = Math.random() < 0.3 ? circles(view) : pass(view);
        if (!path) return bird.reset();
        s = 0;
        size = rand(0.94, 1.08);
        rate = rand(3.2, 3.6);
        phase = LEVEL_PHASE;
        flap = flapTarget = path.soar ? 0 : 1;
        wantFlap = !path.soar;
        bout = path.soar ? rand(3, 7) : rand(1, 2.6);
        rolled = false;
        rollT = -1;
        up = null;
      }
      s += path.speed * dt;
      if (s >= path.length) return bird.reset();
      bird.alpha = smooth(s / FADE) * smooth((path.length - s) / FADE);

      // Heading and bank. The lift must carry the bird's weight and turn it,
      // so it leans along gravity plus the turn's acceleration (a coordinated
      // turn); eased so the bank never snaps.
      const ds = 2;
      const p = along(path, s);
      const ahead = along(path, s + ds);
      const behind = along(path, s - ds);
      const fwd = unit(sub(ahead, behind));
      const k = (path.speed / ds) ** 2;
      const accel = mul(sub(add(ahead, behind), mul(p, 2)), k);
      let lift = add(accel, [0, G, 0]);
      lift = unit(sub(lift, mul(fwd, dot(lift, fwd))));
      const eased = up ? unit(lerp(up, lift, 1 - Math.exp(-dt / 0.3))) : lift;
      up = unit(sub(eased, mul(fwd, dot(eased, fwd))));

      // Rolling onto its back and over again, once, in a glide.
      if (!rolled && path.rollAt >= 0 && s >= path.rollAt) {
        wantFlap = false;
        if (flap === 0 && rollT < 0) rollT = 0;
      }
      let roll = 0;
      if (rollT >= 0) {
        rollT += dt;
        const half = 0.55;
        roll =
          Math.PI * smooth(rollT / half) +
          Math.PI * smooth((rollT - half - 0.2) / half);
        if (rollT > 2 * half + 0.2) {
          rollT = -1;
          rolled = true;
          bout = rand(0.4, 1);
        }
      }
      const rolling = rollT >= 0;

      // Bouts of flapping and gliding; always flapping to climb, never to
      // dive. A beat ends where the wing passes the glide pose.
      if (!rolling && (rolled || path.rollAt < 0 || s < path.rollAt)) {
        bout -= dt;
        if (bout <= 0) {
          wantFlap = !wantFlap;
          bout = path.soar
            ? wantFlap
              ? rand(0.6, 1.2)
              : rand(5, 10)
            : wantFlap
              ? rand(1, 2.6)
              : rand(0.7, 2.2);
        }
      }
      let flapping = wantFlap && !rolling;
      if (!rolling && fwd[1] > 0.07) flapping = true;
      if (fwd[1] < -0.07) flapping = false;
      if (flapping && flap === 0) phase = LEVEL_PHASE;
      if (flapping) flapTarget = 1;
      // Once the last beat reaches the glide pose, hold it there and ease out.
      if (flap > 0 && flapTarget > 0) {
        const last = phase;
        phase = (phase + rate * dt) % 1;
        const passed =
          last <= phase
            ? last < LEVEL_PHASE && phase >= LEVEL_PHASE
            : last < LEVEL_PHASE || phase >= LEVEL_PHASE;
        if (!flapping && passed) flapTarget = 0;
      }
      flap =
        flapTarget > flap
          ? Math.min(1, flap + dt / 0.15)
          : Math.max(0, flap - dt / 0.12);

      let rest = path.soar ? SOAR : GLIDE;
      const tuck = Math.max(smooth((-fwd[1] - 0.06) / 0.14), rolling ? 0.6 : 0);
      rest = blend(rest, TUCK, tuck);
      const pose = flap > 0 ? blend(rest, beat(phase), smooth(flap)) : rest;

      // Body axes: nose up a few degrees to the airflow, then the roll.
      const aoa = (flap > 0 ? 3 : 4.5) * RAD;
      let u = up;
      let f = fwd;
      [f, u] = [
        add(mul(f, Math.cos(aoa)), mul(u, Math.sin(aoa))),
        sub(mul(u, Math.cos(aoa)), mul(f, Math.sin(aoa))),
      ];
      if (roll)
        u = add(mul(u, Math.cos(roll)), mul(cross(f, u), Math.sin(roll)));
      const r = cross(u, f);

      const local: V[] = [...BODY_TRIS];
      const right: V[] = [];
      wing(pose, right);
      local.push(...right, ...right.map((v): V => [-v[0], v[1], v[2]]));
      tail(pose, local);
      let o = 0;
      for (let i = 0; i < local.length; i += 3) {
        const w = [local[i]!, local[i + 1]!, local[i + 2]!].map((v): V =>
          add(p, mul(add(add(mul(r, v[0]), mul(u, v[1])), mul(f, v[2])), size)),
        ) as [V, V, V];
        const n = unit(cross(sub(w[1], w[0]), sub(w[2], w[0])));
        for (const q of w) {
          mesh.set([q[0], q[1], q[2], n[0], n[1], n[2]], o);
          o += RAVEN_STRIDE;
        }
      }
      bird.count = o / RAVEN_STRIDE;
    },
  };
  return bird;
}
