import type { FilamentType } from '../types'

export type { FilamentType }

/**
 * Snap-fit socket tolerances by filament.
 * Mouth ratio < 1 → retaining lip. Closer to 1 = gentler (PLA-safe).
 */
export interface FilamentProfile {
  id: FilamentType
  label: string
  /** Short note shown in the UI */
  hint: string
  /** Socket sphere radius as a multiple of ball radius */
  socketClearance: number
  /** Mouth opening as a multiple of ball radius (< 1 = snap lip) */
  mouthRatio: number
  /** Radial flex slots cut through the lip (helps brittle plastics) */
  flexSlots: number
  /**
   * Smallest lip overhang in mm (ballR − mouthR). The ratio alone gives tiny
   * balls a lip below printer precision (Ø3 mm elbow ≈ 0.07 mm → pops out).
   */
  minLipMm?: number
  /** Largest lip overhang in mm — big balls otherwise get a lip that cracks on insert */
  maxLipMm?: number
  /** Largest radial gap in the cup in mm — big balls otherwise get floppy */
  maxGapMm?: number
  /** False until a real print confirms the snap. Shown grayed out and not selectable. */
  tested: boolean
}

/**
 * Locked PLA print-test values — do not change without reprinting the test square.
 * ISOLATION: ball snap only. Hinge / swivel / universal numbers live in their
 * own profile modules and must not write here.
 */
export const PLA_VALIDATED = {
  socketClearance: 1.05,
  mouthRatio: 0.955,
  flexSlots: 4,
  // mm limits: the Ø8 test ball (lip 0.18, gap 0.20) sits inside them, so the
  // validated square is unchanged; they only kick in on very small / large balls.
  minLipMm: 0.12,
  maxLipMm: 0.25,
  maxGapMm: 0.2,
} as const

/** Below this the stem is too thin to survive normal handling in PLA */
export const MIN_RELIABLE_BALL_DIAMETER_MM = 4

/** Never close the mouth past this, however small the ball */
const MIN_MOUTH_RATIO = 0.85

export const FILAMENT_PROFILES: Record<FilamentType, FilamentProfile> = {
  pla: {
    id: 'pla',
    label: 'PLA',
    hint: 'Print-tested: seats with friction, holds pose. PLA+ uses this same snap.',
    tested: true,
    // VALIDATED by user print (v9/v10 test pair) — keep in sync with gen-pla-test-joint
    socketClearance: PLA_VALIDATED.socketClearance,
    mouthRatio: PLA_VALIDATED.mouthRatio,
    flexSlots: PLA_VALIDATED.flexSlots,
    minLipMm: PLA_VALIDATED.minLipMm,
    maxLipMm: PLA_VALIDATED.maxLipMm,
    maxGapMm: PLA_VALIDATED.maxGapMm,
  },
  // Same geometry as PLA. PLA+ is tougher, so the lip that already inserts in
  // brittle PLA still inserts here. A looser cup would only make the joint floppy.
  pla_plus: {
    id: 'pla_plus',
    label: 'PLA+',
    hint: 'Same snap as PLA. Switch plastics for toughness; the cup and lip stay put.',
    tested: true,
    socketClearance: PLA_VALIDATED.socketClearance,
    mouthRatio: PLA_VALIDATED.mouthRatio,
    flexSlots: PLA_VALIDATED.flexSlots,
    minLipMm: PLA_VALIDATED.minLipMm,
    maxLipMm: PLA_VALIDATED.maxLipMm,
    maxGapMm: PLA_VALIDATED.maxGapMm,
  },
  petg: {
    id: 'petg',
    label: 'PETG',
    hint: 'Flexible enough for a firmer retaining lip',
    tested: false,
    socketClearance: 1.08,
    mouthRatio: 0.9,
    flexSlots: 0,
  },
  abs: {
    id: 'abs',
    label: 'ABS / ASA',
    hint: 'Strong snap — tighter lip',
    tested: false,
    socketClearance: 1.07,
    mouthRatio: 0.88,
    flexSlots: 0,
  },
  tpu: {
    id: 'tpu',
    label: 'TPU',
    hint: 'Very flexible — firm lip, easy first insert',
    tested: false,
    socketClearance: 1.06,
    mouthRatio: 0.85,
    flexSlots: 0,
  },
}

export const DEFAULT_FILAMENT: FilamentType = 'pla'

export function getFilamentProfile(id: FilamentType): FilamentProfile {
  return FILAMENT_PROFILES[id] ?? FILAMENT_PROFILES.pla
}

/** Socket sphere + mouth radii from ball radius (same math as PLA test square). */
export function socketRadialDims(ballR: number, filament: FilamentProfile) {
  const gap = Math.min(
    ballR * (filament.socketClearance - 1),
    filament.maxGapMm ?? Infinity,
  )
  const lip = Math.min(
    Math.max(ballR * (1 - filament.mouthRatio), filament.minLipMm ?? 0),
    filament.maxLipMm ?? Infinity,
    ballR * (1 - MIN_MOUTH_RATIO),
  )
  return {
    socketR: ballR + gap,
    mouthR: ballR - lip,
  }
}
