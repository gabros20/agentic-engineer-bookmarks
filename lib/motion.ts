import type { Transition } from "motion/react";

// Motion tokens for motion/react, mirroring the CSS ones in app/globals.css. One vocabulary for
// the whole app: enters ease out, exits are faster than enters, springs carry no bounce except
// on gestures. Reduced motion is handled at the call site (opacity only, no travel).

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

export const DURATION = { press: 0.14, fast: 0.18, base: 0.24 } as const;

/** Something arriving on screen: a message, a card, a section of a streamed answer. */
export const enter: Transition = { duration: DURATION.base, ease: EASE_OUT };
/** Leaving is quicker than arriving. */
export const exit: Transition = { duration: DURATION.fast, ease: EASE_OUT };
/** Interruptible layout/position changes (a list re-ordering, a pill moving). */
export const spring: Transition = { type: "spring", duration: 0.35, bounce: 0 };

/** Delay for the n-th item of a list that enters together (capped so long lists don't drag). */
export function stagger(index: number, step = 0.035, max = 0.25) {
  return Math.min(index * step, max);
}
