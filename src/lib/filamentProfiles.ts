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
}

/** Locked PLA print-test values — do not change without reprinting the test square. */
export const PLA_VALIDATED = {
  socketClearance: 1.05,
  mouthRatio: 0.955,
  flexSlots: 4,
} as const

export const FILAMENT_PROFILES: Record<FilamentType, FilamentProfile> = {
  pla: {
    id: 'pla',
    label: 'PLA',
    hint: 'Print-tested: seats with friction, holds pose. Same values used on model cuts.',
    // VALIDATED by user print (v9/v10 test pair) — keep in sync with gen-pla-test-joint
    socketClearance: PLA_VALIDATED.socketClearance,
    mouthRatio: PLA_VALIDATED.mouthRatio,
    flexSlots: PLA_VALIDATED.flexSlots,
  },
  pla_plus: {
    id: 'pla_plus',
    label: 'PLA+',
    hint: 'Softer snap than PETG — flex slots + easy lead-in',
    socketClearance: 1.12,
    mouthRatio: 0.96,
    flexSlots: 3,
  },
  petg: {
    id: 'petg',
    label: 'PETG',
    hint: 'Flexible enough for a firmer retaining lip',
    socketClearance: 1.08,
    mouthRatio: 0.9,
    flexSlots: 0,
  },
  abs: {
    id: 'abs',
    label: 'ABS / ASA',
    hint: 'Strong snap — tighter lip',
    socketClearance: 1.07,
    mouthRatio: 0.88,
    flexSlots: 0,
  },
  tpu: {
    id: 'tpu',
    label: 'TPU',
    hint: 'Very flexible — firm lip, easy first insert',
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
  return {
    socketR: ballR * filament.socketClearance,
    mouthR: ballR * filament.mouthRatio,
  }
}
