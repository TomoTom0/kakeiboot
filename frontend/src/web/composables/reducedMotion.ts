// The single prefers-reduced-motion probe (TASK-146 §3 方針1): every
// transition vocabulary (the shell's slide / page fades, the ContentSwap
// pane transitions, the trend window's slide, the overlay appear fades)
// consults this one function for the JS-side skip; the stylesheet repeats
// the same media query as the second guard. navDirection.ts and
// trendWindow.ts carried their own private matchMedia reads before this
// module folded them in.
export function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
