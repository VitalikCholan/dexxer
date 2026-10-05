// app/src/ui/sliderGesture.ts
//
// What a touch on `LeverageSlider` means, from its total movement (dp). Pure so it runs under
// `npm test`. Found on the AVD (05.10.2026): the slider took every touch that started on it, so
// a vertical page scroll silently moved leverage 2× → 6×. Only a tap or a mostly horizontal
// drag may change the value; anything at least as vertical as horizontal is a scroll.

/** Movement below this on both axes is a tap, not a drag. */
export const TAP_SLOP = 6

export type SliderIntent = 'tap' | 'drag' | 'scroll'

export function sliderIntent(dx: number, dy: number): SliderIntent {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < TAP_SLOP && ay < TAP_SLOP) return 'tap'
  return ax > ay ? 'drag' : 'scroll'
}
