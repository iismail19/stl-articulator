/**
 * Shared ball/stem strength geometry.
 * Used by cut engine, preview markers, printable hardware, and PLA test STLs
 * so app joints and downloadable tests cannot drift.
 *
 * Strength rules (from PLA print feedback):
 * - Thick neck (stemR ≈ 0.52·ball) — skinny mid-shaft was the break point
 * - Short exposed cylinder — body collar + ball cone nearly meet
 * - Still enough stick-out for tilt clearance on curved heads
 */
export const BALL_STEM = {
  /**
   * Ball radius as a fraction of joint world radius.
   * Lower = smaller limb joints that fit tight shoulders/wrists (was 0.55 — filled sockets).
   */
  ballOfR: 0.4,
  /** Stem radius as a fraction of ball radius (thicker = stronger) */
  stemOfBall: 0.52,
  /** Target stick-out of ball center from cut face */
  stemHOfBall: 1.25,
  stemHOfR: 0.5,
  /** How far the root embeds into the +side body (deeper = survives kerf gap) */
  embedOfBall: 0.7,
  embedOfR: 0.22,

  /** Cone sitting on the ball (wide on sphere → stem) */
  ballChamferHOfBall: 0.55,
  ballChamferHOfStem: 1.8,
  ballChamferWideOfBall: 0.82,
  ballChamferNarrowOfStem: 1.06,
  /** Where chamfer starts relative to ball center, toward the stem */
  ballChamferStartOfBall: 0.22,
  /** Mid-stem begins this far into the ball chamfer (higher = shorter neck) */
  ballChamferOverlap: 0.72,

  /** Body-side root cone (wide at part → stem) */
  collarHOfStem: 2.4,
  collarHOfBall: 0.65,
  collarNarrowOfStem: 1.08,
  collarWideOfStem: 2.85,
  stepHOfStem: 1.1,
  stepHOfBall: 0.28,
  stepNarrowOfStem: 1.05,
  stepWideOfStem: 1.85,

  /** Floor for the short mid-cylinder between the two cones */
  midStemMinOfBall: 0.18,
} as const

export type BallStemDims = {
  r: number
  ballR: number
  stemR: number
  stemH: number
  embed: number
  /** Ball center along local stem axis (negative = toward −side) */
  ballZ: number
  ballChamferH: number
  ballChamferWide: number
  ballChamferNarrow: number
  collarH: number
  stepH: number
}

/** Core dims from a joint world radius (or equivalent). */
export function computeBallStemDims(r: number): BallStemDims {
  const P = BALL_STEM
  const ballR = Math.min(r * P.ballOfR, r)
  const stemR = ballR * P.stemOfBall
  const stemH = Math.max(ballR * P.stemHOfBall, r * P.stemHOfR)
  const embed = Math.max(ballR * P.embedOfBall, r * P.embedOfR)
  const ballZ = -stemH
  const ballChamferH = Math.max(ballR * P.ballChamferHOfBall, stemR * P.ballChamferHOfStem)
  return {
    r,
    ballR,
    stemR,
    stemH,
    embed,
    ballZ,
    ballChamferH,
    ballChamferWide: ballR * P.ballChamferWideOfBall,
    ballChamferNarrow: stemR * P.ballChamferNarrowOfStem,
    collarH: Math.max(stemR * P.collarHOfStem, ballR * P.collarHOfBall),
    stepH: Math.max(stemR * P.stepHOfStem, ballR * P.stepHOfBall),
  }
}

/**
 * Short mid-stem between ball chamfer and body root.
 * Local +Z toward the body / cut face; ball at ballZ (negative).
 */
export function midStemPlacement(dims: BallStemDims): { z0: number; len: number } {
  const P = BALL_STEM
  const { ballR, ballZ, ballChamferH, embed, stemH } = dims
  const chamferZ0 = ballZ + ballR * P.ballChamferStartOfBall
  const z0 = chamferZ0 + ballChamferH * P.ballChamferOverlap
  const len = Math.max(embed - z0 + stemH * 0.02, ballR * P.midStemMinOfBall)
  return { z0, len }
}
