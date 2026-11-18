// Wires the header's Settings panel (Header.astro) to the reader's sound
// choice, as the GMT docs do (gmt apps/dox/src/lib/sound/control.ts and
// lib/settings-control.ts).
//
// - The gear opens the panel itself (`popovertarget`): Escape, an outside
//   press and focus return are the browser's. Its `aria-expanded` follows the
//   panel, and opening moves focus to the first control, the mute button.
// - The mute button toggles mute and keeps the level. It plays the Ice snap
//   itself (it carries `data-cue`, so the press ping stays out).
// - The fader writes the level and plays a Glass tick on each notch; moving it
//   while muted unmutes at the new level.
// - Nothing is written on mount. A change here or in another tab repaints
//   both, and keeps `data-sound` on <html> true to the mute.

import { cue } from "./cue";
import {
  MAX_LEVEL,
  MIN_LEVEL,
  onSoundChange,
  readSound,
  writeSound,
  type SoundSettings,
} from "./settings";

export function mountSoundControl(): void {
  const panel = document.getElementById("ng-settings");
  const gear = document.querySelector<HTMLButtonElement>(
    '[popovertarget="ng-settings"]',
  );
  const mute = document.getElementById("ng-sound-mute");
  const fader = document.getElementById("ng-sound-fader");
  if (
    !panel ||
    !(mute instanceof HTMLButtonElement) ||
    !(fader instanceof HTMLInputElement)
  ) {
    return;
  }
  const muteButton = mute;
  const faderInput = fader;
  let muted = true;
  let notch = Number(faderInput.value);

  function paint(settings: SoundSettings): void {
    muted = settings.muted;
    notch = settings.level;
    muteButton.setAttribute("aria-pressed", String(settings.muted));
    document.documentElement.dataset.sound = settings.muted ? "off" : "on";
    faderInput.value = String(settings.level);
    faderInput.setAttribute(
      "aria-valuetext",
      `Volume ${settings.level} of ${MAX_LEVEL}${settings.muted ? ", muted" : ""}`,
    );
    faderInput.style.setProperty(
      "--gmt-range-pct",
      String(((settings.level - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL)) * 100),
    );
  }
  paint(readSound());
  onSoundChange(paint);

  panel.addEventListener("toggle", (event) => {
    const open = (event as ToggleEvent).newState === "open";
    gear?.setAttribute("aria-expanded", String(open));
    // A popover does not take focus by itself: the first control is where a
    // keyboard reader goes next.
    if (open) muteButton.focus();
  });

  muteButton.addEventListener("click", () => {
    if (muted) {
      writeSound({ muted: false });
      // Unmuting is what loads the engine, a moment later: cue one task after
      // it has loaded, by when cue.ts has attached it.
      void import("./engine").then(() => setTimeout(() => cue("toggle"), 0));
    } else {
      cue("toggle");
      writeSound({ muted: true });
    }
  });

  faderInput.addEventListener("input", () => {
    const level = Number(faderInput.value);
    if (level !== notch) cue("detent");
    writeSound({ level, muted: false });
  });
}
