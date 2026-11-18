// The audio engine: owns the master bus and plays the voices. Loaded by
// `cue.ts` on idle or on the first press, and only while sound is on. Ported
// from the GMT docs (gmt apps/dox/src/lib/sound/engine.ts).
//
// It is handed an AudioContext that a press or an in-site arrival started
// (`attach`), and only then listens for cues: one before that is unheard,
// which drops it. A cue while the context is suspended is dropped too, unless
// a press is starting it. Every schedule, gap and fade reads the audio clock.
//
// Besides the cues it hears Huginn (`ng:huginn`, from Aurora.astro) and wires
// the page's own sounds: the Distant sonar on a press of any link or button
// (a link that leaves in this tab waits for it, link-hold.ts) and the Felt
// slide as a panel opens or closes.

import type { HuginnSound } from "../aurora.worker";
import {
  cue,
  CUE_EVENT,
  HUGINN_EVENT,
  PLACE_EVENT,
  type CueDetail,
  type CueName,
} from "./cue";
import { huginnVoice, type HuginnVoice } from "./huginn";
import { holdLink } from "./link-hold";
import { ceiling, setMaster } from "./kit";
import { onSoundChange, readSound, type SoundSettings } from "./settings";
import { VOICES } from "./voices";
import { startAir, type Place } from "./wind";

/** The air of the place rises over this long once sound starts. */
const WIND_FADE_IN = 3;

/** The sky drawn, as Aurora.astro marks it on <html> (`data-sky-site`). */
function placeShown(): Place {
  return document.documentElement.dataset.skySite === "helsinki"
    ? "helsinki"
    : "isafjordur";
}

const MAX_GAIN = 0.6;
const MUTE_RAMP = 0.05;
/** Seconds ahead of now a cue starts, so its attack is not clipped. Cues that
 * read the clock less than this apart start together. */
const LEAD = 0.005;
const DEFAULT_GAP = 0.03;
/** Cues that keep their own gap: boxes may start drawing in together. */
const GAPS: Partial<Record<CueName, number>> = { brush: 0 };
/** A hidden tab keeps sounding this long, so a link that opened a new tab is
 * heard to the end of its press: the Distant sonar rings on in its space of
 * water, and a tail cut short would play its rest on the way back. */
const HIDE_TAIL_MS = 1200;

export type Engine = {
  attach(ctx: AudioContext): void;
};

type ActivationNavigator = Navigator & {
  userActivation?: { isActive: boolean };
};

/** Whether a sound may be scheduled now: on a running context, yes; on a
 * suspended one only inside a press, which is starting it. Anything scheduled
 * on a stopped clock would play at once, in a burst, when it starts. */
function live(c: AudioContext): boolean {
  if (c.state === "running") return true;
  if (c.state !== "suspended") return false;
  return (navigator as ActivationNavigator).userActivation?.isActive ?? false;
}

function levelGain(settings: SoundSettings): number {
  return settings.muted ? 0 : (settings.level / 11) * MAX_GAIN;
}

/** A press on any link or button plays the Distant sonar. The dispatch path,
 * not `target.closest`: a control may swap its own icon. A control that plays
 * its own sound carries `data-cue` (the mute button). */
function onPress(event: Event): void {
  const path = event
    .composedPath()
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  const el = path.find((node) => node.matches(PRESSABLE));
  // An `<a>` with no `href` is not a control.
  if (!el || el.matches("a:not([href])")) return;
  if (path.some((node) => node.hasAttribute("data-cue"))) return;
  // A link that leaves the page in this tab waits for its ping.
  if (
    cue("click") &&
    el instanceof HTMLAnchorElement &&
    event instanceof MouseEvent
  ) {
    holdLink(event, el);
  }
}

/** Every control a press plays the ping on: links and buttons alike. */
const PRESSABLE = 'a[href], button, [role="button"], summary';

/** The Felt slide as any non-manual popover opens or closes. `toggle` does
 * not bubble, but it is captured. */
function onToggle(event: Event): void {
  const el = event.target;
  if (
    !(el instanceof HTMLElement) ||
    !el.hasAttribute("popover") ||
    el.getAttribute("popover") === "manual"
  ) {
    return;
  }
  const open = (event as ToggleEvent).newState === "open";
  cue(open ? "open" : "close");
}

export function createEngine(): Engine {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let huginn: HuginnVoice | null = null;
  let settings = readSound();
  let hidden = document.visibilityState === "hidden";
  let suspendTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const lastPlayed = new Map<CueName, number>();
  let together = -Infinity;

  function fade(to: number, over: number): void {
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(to, now + over);
  }

  function apply(next: SoundSettings): void {
    const was = settings;
    settings = next;
    if (!ctx || !master) return;
    clearTimeout(suspendTimer);
    suspendTimer = undefined;
    if (next.muted) {
      fade(0, MUTE_RAMP);
      suspendTimer = setTimeout(
        () => {
          suspendTimer = undefined;
          if (ctx && settings.muted) void ctx.suspend().catch(() => {});
        },
        MUTE_RAMP * 1000 + 10,
      );
    } else if (was.muted) {
      if (!hidden) void ctx.resume().catch(() => {});
      fade(levelGain(next), MUTE_RAMP);
    } else {
      master.gain.setTargetAtTime(levelGain(next), ctx.currentTime, 0.015);
    }
  }

  function onCue(event: Event): void {
    if (!ctx || !master || settings.muted || !live(ctx)) return;
    const detail = (event as CustomEvent<CueDetail>).detail;
    const voice = VOICES[detail.name];
    if (!voice) return;
    const now = ctx.currentTime;
    const last = lastPlayed.get(detail.name);
    const gap = GAPS[detail.name] ?? DEFAULT_GAP;
    if (last !== undefined && now - last < gap) return;
    lastPlayed.set(detail.name, now);
    if (!(now - together < LEAD)) together = now;
    voice(ctx, master, together + LEAD, detail.rank ?? 0, detail.extra);
    detail.heard = true;
  }

  function onHuginn(event: Event): void {
    if (!ctx || !master || settings.muted || ctx.state !== "running") return;
    huginn ??= huginnVoice(ctx, master);
    huginn.hear((event as CustomEvent<HuginnSound>).detail);
  }

  function onVisibility(): void {
    if (!ctx) return;
    hidden = document.visibilityState === "hidden";
    clearTimeout(hideTimer);
    hideTimer = undefined;
    if (hidden) {
      hideTimer = setTimeout(() => {
        hideTimer = undefined;
        if (ctx && hidden) void ctx.suspend().catch(() => {});
      }, HIDE_TAIL_MS);
    } else if (!settings.muted) {
      void ctx.resume().catch(() => {});
    }
  }

  /** The back/forward cache froze the page: the context sleeps. */
  function onPageHide(): void {
    if (ctx) void ctx.suspend().catch(() => {});
  }

  /** Restored from the cache: resume at once if the browser lets it, else on
   * the next press. */
  function onPageShow(event: PageTransitionEvent): void {
    if (!event.persisted || !ctx || settings.muted) return;
    const c = ctx;
    void c.resume().catch(() => {});
    if (c.state === "running") return;
    function again(): void {
      window.removeEventListener("pointerdown", again, true);
      window.removeEventListener("keydown", again, true);
      void c.resume().catch(() => {});
    }
    window.addEventListener("pointerdown", again, true);
    window.addEventListener("keydown", again, true);
  }

  onSoundChange(apply);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  return {
    attach(next) {
      if (ctx === next) return;
      ctx = next;
      settings = readSound();
      master = next.createGain();
      master.gain.value = levelGain(settings);
      // Nothing reaches the speakers over the ceiling, whatever a voice does.
      master.connect(ceiling(next)).connect(next.destination);
      setMaster(next, master);
      // Honour the phone's silent switch where the browser lets a page say so.
      const session = (
        navigator as Navigator & { audioSession?: { type: string } }
      ).audioSession;
      if (session) session.type = "ambient";
      document.addEventListener(CUE_EVENT, onCue);
      document.addEventListener(HUGINN_EVENT, onHuginn);
      document.addEventListener("click", onPress, { capture: true });
      document.addEventListener("toggle", onToggle, { capture: true });
      // Under the sky, the light breeze of the place drawn (./wind.ts),
      // moving to the other's when the sky switches. It runs for the page's
      // life: muting fades the master and a hidden tab suspends the context,
      // so nothing else needs to stop it.
      if (document.querySelector(".aurora")) {
        const air = startAir(next, master, placeShown(), WIND_FADE_IN);
        document.addEventListener(PLACE_EVENT, () => air.moveTo(placeShown()));
      }
    },
  };
}
