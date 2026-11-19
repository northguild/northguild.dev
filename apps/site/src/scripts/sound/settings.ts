// The reader's sound choice: a level and a mute. The same record the GMT docs
// keep (gmt apps/dox/src/lib/sound/settings.ts): both sites share one origin,
// so a choice made on either holds on the other. This site writes only
// `level` and `muted`; the docs' `aura` and `track` pass through as stored.
//
// Sound is opt-in. Every visitor starts muted, and only the reader's own
// choice in the settings panel turns it on. Anything this build cannot read
// (no record, corrupt JSON, another version, a field of the wrong type) reads
// as muted, so a bad record can never turn sound on. Base.astro reads the
// same key inline, before first paint, to draw the speaker right.
//
// Storage can throw (private windows, blocked site data, a full quota). A
// choice it cannot keep still holds for the rest of the page. A change in
// another tab arrives through `storage`; a page restored from the
// back/forward cache missed those, so it reads the key again on `pageshow`.

/** The `localStorage` key, shared with the GMT docs. */
export const SOUND_KEY = "dox:sound";

/** The record's version, saved as `v`; another reads as the default. */
export const SOUND_VERSION = 1;

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 11;

export type SoundSettings = {
  /** The volume notch, 1 to 11. */
  level: number;
  muted: boolean;
};

/** Where a change came from: this page's own write, or another tab's. */
export type SoundOrigin = "local" | "storage";

type Listener = (settings: SoundSettings, origin: SoundOrigin) => void;

function defaultSound(): SoundSettings {
  return { level: 5, muted: true };
}

function clampLevel(value: number): number {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(value)));
}

/** The stored record as it is, fields this site does not use included. */
function storedRecord(): Record<string, unknown> | null {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(SOUND_KEY) ?? "null",
    );
    if (typeof saved !== "object" || saved === null) return null;
    const record = saved as Record<string, unknown>;
    return record.v === SOUND_VERSION ? record : null;
  } catch {
    return null;
  }
}

function storedSound(): SoundSettings {
  const settings = defaultSound();
  const record = storedRecord();
  if (!record) return settings;
  if (typeof record.level === "number" && Number.isFinite(record.level)) {
    settings.level = clampLevel(record.level);
  }
  if (typeof record.muted === "boolean") settings.muted = record.muted;
  return settings;
}

/** This page's last choice while storage has not kept it. */
let unsaved: SoundSettings | null = null;
const listeners = new Set<Listener>();

/** The choice in force: this page's unsaved one, the saved one, or the default. */
export function readSound(): SoundSettings {
  return unsaved ? { ...unsaved } : storedSound();
}

/** Save a reader's choice and tell this page's listeners. */
export function writeSound(patch: Partial<SoundSettings>): SoundSettings {
  const next = { ...readSound(), ...patch };
  next.level = clampLevel(next.level);
  try {
    // Keep the docs' own fields (the aura and its track) as they are.
    const record = {
      aura: true,
      track: "ice",
      ...storedRecord(),
      v: SOUND_VERSION,
      level: next.level,
      muted: next.muted,
    };
    localStorage.setItem(SOUND_KEY, JSON.stringify(record));
    unsaved = null;
  } catch {
    // Not remembered for the next page, but it holds for this one.
    unsaved = next;
  }
  for (const listener of listeners) listener({ ...next }, "local");
  return { ...next };
}

/** Call `listener` on a change here, in another tab, or on a return from the
 * back/forward cache. Returns the way to stop. */
export function onSoundChange(listener: Listener): () => void {
  listeners.add(listener);
  function onStorage(event: StorageEvent): void {
    if (event.key !== SOUND_KEY && event.key !== null) return;
    // Another tab's write is newer than any choice this page could not save.
    unsaved = null;
    listener(readSound(), "storage");
  }
  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) listener(readSound(), "storage");
  }
  window.addEventListener("storage", onStorage);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pageshow", onPageShow);
  };
}
