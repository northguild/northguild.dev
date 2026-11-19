// The one sound module every page loads at once: `cue(name)` fires a sound,
// and `startCue()` arms the unlock. Ported from the GMT docs
// (gmt apps/dox/src/lib/sound/cue.ts), keeping their rules.
//
// Nothing here makes a sound. `cue` dispatches `ng:cue` on the document; the
// engine (./engine.ts) listens once it has loaded and the reader has let
// audio start, and until then the event is unheard, which drops the cue.
// Nothing queues. The engine is only ever reached through `import()`, so the
// first paint carries this file and the settings and none of the audio code.
//
// Unlock, in order of a page's life:
// 1. Muted: no AudioContext and no engine. Unmuting is itself a press.
// 2. Not muted: capture-phase listeners for the first press or key create and
//    resume the context synchronously; Safari does not count a resume after
//    an `await`. They go once the context runs.
// 3. Arriving from another page of this site (the GMT docs) with sound on,
//    unlock at load: Chrome lets a page reached by a same-origin navigation
//    start audio, so Huginn's fly-in and the draw-in are heard. Where the
//    browser refuses, the context stays suspended and step 2 waits.

import { onSoundChange, readSound } from "./settings";

export type CueName =
  | "click"
  | "open"
  | "close"
  | "toggle"
  | "detent"
  | "brush";

/** Extra for a cue whose voice needs it: a page box drawing in. */
export type CueExtra = {
  /** Seconds the sweep takes. */
  duration: number;
  kind: "header" | "card" | "text";
  /** Where the box is, -1 left to 1 right, and the way the sweep drifts. */
  pan: number;
  drift: number;
};

export const CUE_EVENT = "ng:cue";

/** The event Aurora.astro dispatches for each of Huginn's sounds from the
 * worker; the engine hears it once running (./huginn.ts). Here, not in the
 * engine, so the page can name it without loading the engine. */
export const HUGINN_EVENT = "ng:huginn";

/** The event Aurora.astro dispatches when the sky drawn changes place; the
 * engine moves the air of the place with it (./wind.ts). */
export const PLACE_EVENT = "ng:place";

export type CueDetail = {
  name: CueName;
  rank?: number;
  extra?: CueExtra;
  /** Set by the engine when it plays the cue. */
  heard?: boolean;
};

/** Play a cue now, or drop it if the engine is not running. Returns whether it
 * was heard. */
export function cue(name: CueName, rank?: number, extra?: CueExtra): boolean {
  const detail: CueDetail = { name };
  if (rank !== undefined) detail.rank = rank;
  if (extra) detail.extra = extra;
  document.dispatchEvent(new CustomEvent<CueDetail>(CUE_EVENT, { detail }));
  return detail.heard === true;
}

/** The slice of the engine this file talks to. */
type Engine = {
  attach(ctx: AudioContext): void;
};

const GESTURES = ["pointerdown", "pointerup", "keydown", "touchend"] as const;

type AutoplayNavigator = Navigator & {
  getAutoplayPolicy?: (type: string) => string;
};

/** Whether the browser reports this page was reached from one of our own. */
function arrivedFromSite(): boolean {
  const nav = (
    window as Window & {
      navigation?: { activation?: { from?: { url?: string } | null } };
    }
  ).navigation;
  const from = nav?.activation?.from?.url;
  if (!from) return false;
  try {
    return new URL(from).origin === location.origin;
  } catch {
    return false;
  }
}

/** Arm the sound for this page. */
export function startCue(): void {
  let ctx: AudioContext | null = null;
  let engine: Engine | null = null;
  let loading = false;
  let armed = false;

  function attach(): void {
    if (ctx && engine) engine.attach(ctx);
  }

  function disarm(): void {
    if (!armed) return;
    armed = false;
    for (const type of GESTURES)
      window.removeEventListener(type, onGesture, true);
  }

  /** Load the engine off the first-paint path, never while muted. */
  function loadEngine(): void {
    if (loading) return;
    loading = true;
    void import("./engine").then(
      (mod) => {
        engine = mod.createEngine();
        attach();
      },
      () => {
        loading = false;
      },
    );
  }

  /** Create or resume the context. Synchronous: it must run inside the press. */
  function unlock(): void {
    try {
      ctx ??= new AudioContext({ latencyHint: "interactive" });
      ctx.onstatechange = () => {
        if (ctx?.state === "running") disarm();
      };
      void ctx.resume().catch(() => {});
    } catch {
      return;
    }
    loadEngine();
    attach();
    if (ctx.state === "running") disarm();
  }

  function onGesture(): void {
    if (!readSound().muted) unlock();
  }

  function arm(): void {
    if (armed) return;
    armed = true;
    for (const type of GESTURES) window.addEventListener(type, onGesture, true);
  }

  function onIdle(): void {
    if (!readSound().muted) loadEngine();
  }
  if (typeof requestIdleCallback === "function") requestIdleCallback(onIdle);
  else setTimeout(onIdle, 1);

  if (!readSound().muted) {
    arm();
    const policy = (navigator as AutoplayNavigator).getAutoplayPolicy?.(
      "audiocontext",
    );
    if (arrivedFromSite() && (policy === undefined || policy === "allowed")) {
      unlock();
    }
  }

  onSoundChange((settings, origin) => {
    // Muting: the engine ramps down and suspends the context.
    if (settings.muted) return;
    // A reader's own unmute is a press; another tab's is not.
    if (origin === "local") unlock();
    else arm();
  });
}
