/**
 * Knuckle joint (robot-toy style): a round tongue on one limb sits between the
 * two cheeks of a fork on the other limb. A cone bump on each cheek snaps into
 * a cone dimple on each tongue face — that is the axle. No separate pin.
 *
 * Pose hold: the dimples are a little shallower than the bumps (`preload`), so
 * the cheeks stay sprung apart and pinch the tongue at every angle.
 *
 * ISOLATION: the only place knuckle fit numbers live. Editing them never
 * touches the ball snap (`filamentProfiles.ts`) or the hinge (`hingeProfile.ts`).
 *
 * Fit numbers (sideGap, bumpHeight, preload) are absolute mm — printer
 * tolerance does not scale with the model. Shape scales with the limb.
 *
 * LOCKED: v1 passed its PLA print tests (2026-11-07) at this standard size and
 * at the thin Dag 4″ knee size. prove-knuckle-locked.mts fails if these numbers,
 * either test pair, a standard-size model knuckle, or the Dag 4″ cut change.
 */
export const KNUCKLE_TEST = {
  version: 'v1',
  /** Barrel radius — the rounded end both parts share. */
  radius: 4.5,
  /** Total width across the fork (cheek + tongue + cheek). */
  width: 9,
  /** Each fork cheek. Thinner = easier snap, weaker hold. */
  cheek: 2,
  /** Air between each tongue face and its cheek. */
  sideGap: 0.15,
  /** Base radius of the cone bump on each cheek. */
  bumpRadius: 1.6,
  /** How far each bump sticks out of its cheek (45° cone). */
  bumpHeight: 0.6,
  /** Bumps seat this much short of the dimple — the pinch that holds a pose. */
  preload: 0.08,
  /** Test pair only: straight arm on each part. */
  armLength: 12,
} as const

/** Below this the tongue is too thin to carry two dimples in PLA. */
export const MIN_RELIABLE_TONGUE_MM = 2

export type KnuckleSpec = {
  radius: number
  width: number
  cheek: number
  sideGap: number
  bumpRadius: number
  bumpHeight: number
  preload: number
  /** Radial air where each limb is cut back so the other can swing. */
  motionClearance: number
  /**
   * How far from the axis each limb is cleared. Defaults to the barrel + air;
   * the model cut raises it to the limb's own half-width so a limb wider than
   * the barrel can still swing to 90°.
   */
  swing?: number
}

/** Y positions in knuckle-local space; the bend axis is Y through the origin. */
export function knuckleLayout(K: KnuckleSpec) {
  const half = K.width / 2
  const tongueHalf = half - K.cheek - K.sideGap
  const cheekFace = tongueHalf + K.sideGap
  // 45° cones: radial interference equals axial offset, so shrinking the
  // dimple mouth by `preload` makes each bump want to sit `preload` deeper.
  const dimpleMouthR = K.bumpRadius - K.sideGap - K.preload
  const dimpleDepth = K.bumpHeight - K.sideGap + 0.15
  return {
    swing: Math.max(K.swing ?? 0, K.radius + K.motionClearance),
    half,
    tongueHalf,
    tongue: 2 * tongueHalf,
    cheekFace,
    bumpTipR: K.bumpRadius - K.bumpHeight,
    dimpleMouthR,
    dimpleDepth,
    dimpleBottomR: Math.max(dimpleMouthR - dimpleDepth, 0.05),
  }
}

const TEST_SPEC: KnuckleSpec = {
  radius: KNUCKLE_TEST.radius,
  width: KNUCKLE_TEST.width,
  cheek: KNUCKLE_TEST.cheek,
  sideGap: KNUCKLE_TEST.sideGap,
  bumpRadius: KNUCKLE_TEST.bumpRadius,
  bumpHeight: KNUCKLE_TEST.bumpHeight,
  preload: KNUCKLE_TEST.preload,
  motionClearance: 0.35,
}

export function knuckleTestSpec(): KnuckleSpec {
  return { ...TEST_SPEC }
}

/** Size to a joint radius (mm). Shape follows the limb; fit numbers stay. */
export function knuckleDimsForJoint(jRmm: number): KnuckleSpec {
  const radius = Math.max(jRmm * 0.9, 2)
  const s = radius / KNUCKLE_TEST.radius
  const bumpRadius = Math.max(KNUCKLE_TEST.bumpRadius * s, 0.9)
  return {
    radius,
    width: KNUCKLE_TEST.width * s,
    cheek: Math.max(KNUCKLE_TEST.cheek * s, 1.2),
    sideGap: KNUCKLE_TEST.sideGap,
    bumpRadius,
    bumpHeight: Math.min(KNUCKLE_TEST.bumpHeight, bumpRadius * 0.45),
    preload: KNUCKLE_TEST.preload,
    motionClearance: 0.35,
  }
}

/**
 * Fit inside the limb at the cut. `halfX` = room across the bend, `halfY` =
 * room along the axis. The knuckle fills the limb's width like the toy robots.
 * `minCheek` / `minTongue` are in the same units as the spec.
 * Returns null when a fork + tongue can't fit.
 */
export function fitKnuckleToLimb(
  K: KnuckleSpec,
  halfX: number,
  halfY: number,
  minCheek: number,
  minTongue: number,
): KnuckleSpec | null {
  const out = { ...K }
  const maxR = halfX * 0.92
  if (out.radius > maxR) {
    const s = maxR / out.radius
    out.radius = maxR
    out.bumpRadius *= s
    out.bumpHeight = Math.min(out.bumpHeight, out.bumpRadius * 0.45)
  }
  out.width = Math.min(halfY * 2 * 0.92, out.radius * 2.4)
  out.cheek = Math.max(Math.min(out.cheek, out.width * 0.24), minCheek)
  if (knuckleLayout(out).tongue < minTongue) return null
  if (out.bumpRadius > out.radius * 0.6) {
    out.bumpRadius = out.radius * 0.6
    out.bumpHeight = Math.min(out.bumpHeight, out.bumpRadius * 0.45)
  }
  return out
}

export function scaleKnuckleSpec(K: KnuckleSpec, k: number): KnuckleSpec {
  return {
    radius: K.radius * k,
    width: K.width * k,
    cheek: K.cheek * k,
    sideGap: K.sideGap * k,
    bumpRadius: K.bumpRadius * k,
    bumpHeight: K.bumpHeight * k,
    preload: K.preload * k,
    motionClearance: K.motionClearance * k,
    swing: K.swing == null ? undefined : K.swing * k,
  }
}
