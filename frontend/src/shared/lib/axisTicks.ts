// The absolute tick ladder over a scale (TASK-161 §5-3, design: tmp/tasks/
// tm-161/design_period_ui.md v2 — web-common.axis-ticks): ONE pure helper
// every absolute-amount graduation reads, so the Home header breakdown's
// horizontal ticks and the trend y-axis keep the same subdivision rule. The
// scale itself stays the screen-common barScale (TASK-129, the nice 1/2/5
// ladder — this module subdivides, it never picks the bound). TASK-126 later
// points the vertical bars' scale SOURCE at the same barScale; the tick
// generation stays here.
import { compactYen } from '../components/charts/types'

/** one absolute tick: ratio (0..1 along the track — left-to-right on a
 *  horizontal track, top-down (1−ratio) on a vertical axis), the tick's
 *  amount and its compactYen label */
export interface AxisTick {
  ratio: number
  value: number
  label: string
}

/** `steps` subdivisions over `scale`: ascending, both ends (ratio 0 and 1)
 *  always included — steps=4 gives the 5-point 0・1/4・1/2・3/4・1 ladder
 *  (the working hypothesis; the real-device check may simplify to steps=2),
 *  steps=2 the 3-point 0・1/2・1 (the trend y-axis's current vocabulary).
 *  Pure: identical args return identical arrays. */
export function axisTicksOf(scale: number, steps: 4 | 2 = 4): AxisTick[] {
  const n = steps === 2 ? 2 : 4
  return Array.from({ length: n + 1 }, (_, i) => {
    const ratio = i / n
    const value = ratio * scale
    return { ratio, value, label: compactYen(value) }
  })
}
