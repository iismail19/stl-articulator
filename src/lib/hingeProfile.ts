/**
 * Elbow / knee hinge: pinless snap disc ("stud + eye").
 *
 * One limb gets a disc with a split peg molded on; the other gets a disc with a
 * hole. The peg snaps through the hole and its lip clamps the two discs face to
 * face — that face friction is what holds a pose. No separate pin.
 *
 * ISOLATION: this file is the only place hinge fit numbers live. Editing them
 * must never change `filamentProfiles.ts` / `PLA_VALIDATED` (ball snap).
 *
 * Fit numbers are absolute mm (printer tolerance does not scale with the model).
 *
 * LOCKED: v3 passed its PLA print test (2026-11-07). prove-hinge-locked.mts fails
 * if these numbers, the test pair, or a model hinge cut change.
 */
export const HINGE_TEST = {
  version: 'v3',
  /** Disc radius — the round knuckle both parts share. */
  discRadius: 4,
  /** Disc on the stud part (carries the peg). */
  studThickness: 2.6,
  /** Disc on the eye part (carries the hole). */
  eyeThickness: 2.6,
  pegDiameter: 3,
  /** Hole Ø = peg Ø + this. Small = stiffer spin. */
  holeClearance: 0.1,
  /** Radial lip on the peg tip that snaps past the eye. */
  lipMm: 0.2,
  /** Tapered lead-in past the eye face. */
  lipLength: 0.9,
  /** Lip shoulder sits this far inside the eye face, so it clamps the discs together. */
  shoulderPreload: 0.05,
  /** Slot across the peg so the two halves squeeze through the hole. */
  splitWidth: 0.7,
  /** Test-pair only: round arm on each disc. */
  armLength: 12,
  armDiameter: 6,
} as const

/** Below this the peg is too thin to survive handling in PLA. */
export const MIN_RELIABLE_PEG_DIAMETER_MM = 2.4

export type HingeSpec = {
  discRadius: number
  studThickness: number
  eyeThickness: number
  pegDiameter: number
  holeClearance: number
  lipMm: number
  lipLength: number
  shoulderPreload: number
  splitWidth: number
  /** Radial air around each disc where the other limb is cut back, so it can bend. */
  motionClearance: number
  /** How far each disc's arm reaches into its own limb. */
  embed: number
}

/** Y positions in hinge-local space; the bend axis is Y through the origin. */
export function hingeLayout(spec: HingeSpec) {
  const width = spec.studThickness + spec.eyeThickness
  const y0 = -width / 2
  const split = y0 + spec.studThickness
  const yEnd = y0 + width
  const pegR = spec.pegDiameter / 2
  return {
    width,
    stud: [y0, split] as const,
    eye: [split, yEnd] as const,
    split,
    pegR,
    holeR: pegR + spec.holeClearance / 2,
    lipR: pegR + spec.lipMm,
    shoulderY: yEnd - spec.shoulderPreload,
    tipY: yEnd - spec.shoulderPreload + spec.lipLength,
  }
}

const TEST_SPEC: HingeSpec = {
  discRadius: HINGE_TEST.discRadius,
  studThickness: HINGE_TEST.studThickness,
  eyeThickness: HINGE_TEST.eyeThickness,
  pegDiameter: HINGE_TEST.pegDiameter,
  holeClearance: HINGE_TEST.holeClearance,
  lipMm: HINGE_TEST.lipMm,
  lipLength: HINGE_TEST.lipLength,
  shoulderPreload: HINGE_TEST.shoulderPreload,
  splitWidth: HINGE_TEST.splitWidth,
  motionClearance: 0.35,
  embed: HINGE_TEST.armLength,
}

export function hingeTestSpec(): HingeSpec {
  return { ...TEST_SPEC }
}

/**
 * Shrink a hinge so it fits inside the limb at the cut.
 * `halfX` = room from the axis to the limb surface across the bend,
 * `halfY` = room along the hinge axis. Shape shrinks; fit numbers stay.
 * Returns null when even the smallest disc stack is wider than the limb.
 */
export function fitHingeToLimb(
  H: HingeSpec,
  halfX: number,
  halfY: number,
  minThickness: number,
): HingeSpec | null {
  let out = { ...H }
  const maxR = halfX * 0.92
  if (out.discRadius > maxR) {
    const s = maxR / out.discRadius
    out = {
      ...out,
      discRadius: maxR,
      pegDiameter: out.pegDiameter * s,
      lipLength: out.lipLength * s,
      lipMm: Math.min(out.lipMm, out.pegDiameter * s * 0.08),
      splitWidth: Math.min(out.splitWidth, out.pegDiameter * s * 0.25),
      embed: out.embed * s,
    }
  }
  const room = halfY * 2 * 0.95
  const width = out.studThickness + out.eyeThickness
  if (width > room) {
    const s = room / width
    out.studThickness = Math.max(out.studThickness * s, minThickness)
    out.eyeThickness = Math.max(out.eyeThickness * s, minThickness)
    if (out.studThickness + out.eyeThickness > halfY * 2 * 1.05) return null
  }
  return out
}

/**
 * Size the hinge to a joint radius. Shape scales with the limb; fit numbers
 * (clearance, lip, preload, slot) stay in mm so they match the test print.
 */
export function hingeDimsForJoint(jR: number): HingeSpec {
  const discRadius = Math.max(jR * 0.9, 1.6)
  const s = discRadius / HINGE_TEST.discRadius
  const pegDiameter = Math.max(HINGE_TEST.pegDiameter * s, 1.4)
  return {
    discRadius,
    studThickness: Math.max(HINGE_TEST.studThickness * s, 1.2),
    eyeThickness: Math.max(HINGE_TEST.eyeThickness * s, 1.2),
    pegDiameter,
    holeClearance: HINGE_TEST.holeClearance,
    lipMm: Math.min(HINGE_TEST.lipMm, pegDiameter * 0.08),
    lipLength: Math.max(HINGE_TEST.lipLength * s, 0.5),
    shoulderPreload: HINGE_TEST.shoulderPreload,
    splitWidth: Math.min(HINGE_TEST.splitWidth, pegDiameter * 0.25),
    motionClearance: 0.35,
    embed: Math.max(discRadius * 1.1, jR * 0.45),
  }
}
