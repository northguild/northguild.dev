// A link's press waits for its ping, as on the GMT docs
// (gmt apps/dox/src/lib/sound/link-hold.ts). Leaving for another page in
// this tab is a full page load, which ends the page's audio, so the Distant
// sonar would be cut short. When the ping was heard, the navigation is held
// for the ping, then made.
//
// Only a plain press is held: a link another handler has taken
// (`preventDefault`), a press with a modifier key or another button, a link
// that opens a new tab or downloads, a jump within the same page, and a link
// that asks for no referrer are left to the browser. A link that opens a new
// tab needs no hold: the engine lets a hidden tab's sound finish.

/** How long a held link waits, ms: the Distant sonar's ping and the swell of
 * its space of water (voices.ts `click`), heard out before the page goes. */
const LINK_HOLD_MS = 600;

let waiting: (() => void) | undefined;
let pending: ReturnType<typeof setTimeout> | undefined;

/** Whether pressing `link` with `press` leaves this page for another in this
 * tab. */
function leavesInThisTab(press: MouseEvent, link: HTMLAnchorElement): boolean {
  if (press.button !== 0) return false;
  if (press.metaKey || press.ctrlKey || press.shiftKey || press.altKey) {
    return false;
  }
  if (link.target !== "" && link.target !== "_self") return false;
  if (link.hasAttribute("download")) return false;
  if (/\bnoreferrer\b/i.test(link.rel) || link.hasAttribute("referrerpolicy")) {
    return false;
  }
  try {
    const to = new URL(link.href, document.baseURI);
    if (to.protocol !== "http:" && to.protocol !== "https:") return false;
    const here = new URL(location.href);
    const samePage =
      to.origin === here.origin &&
      to.pathname === here.pathname &&
      to.search === here.search;
    return !(samePage && to.hash !== "");
  } catch {
    return false;
  }
}

/**
 * Hold the navigation of `link`'s press until its ping has played. Call it
 * while the press is being dispatched, once its ping is heard: it decides at
 * the end of the dispatch, after every handler on the page has had its turn.
 * A newer held press replaces an older one.
 */
export function holdLink(press: MouseEvent, link: HTMLAnchorElement): void {
  waiting?.();
  function stop(): void {
    window.removeEventListener("click", decide);
    waiting = undefined;
  }
  function decide(event: Event): void {
    // A press that never reached the window (a handler stopped it) is not
    // held; the next click to arrive ends the wait all the same.
    stop();
    if (event !== press) return;
    if (press.defaultPrevented || !leavesInThisTab(press, link)) return;
    press.preventDefault();
    clearTimeout(pending);
    const url = link.href;
    pending = setTimeout(() => {
      pending = undefined;
      location.assign(url);
    }, LINK_HOLD_MS);
  }
  window.addEventListener("click", decide);
  waiting = stop;
}
