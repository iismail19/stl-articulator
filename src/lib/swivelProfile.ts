/**
 * Swivel (forearm / waist twist): a split snap post on one part goes through a
 * hole in the other part's cut face, along the limb. The post turns 360°; its
 * lip clamps the two collar faces together, and that face rub holds the twist.
 * No separate pin.
 *
 * The snap started from the print-tested hinge snap (v3), pointed along the limb.
 * The numbers are copied, not imported, so the locked hinge never moves. The lip
 * is deeper than the hinge's: a twist pulls along the post, and the print test
 * needed the extra catch.
 *
 * ISOLATION: the only place swivel fit numbers live. Editing them never touches
 * the ball (`filamentProfiles.ts`), hinge (`hingeProfile.ts`) or knuckle
 * (`knuckleProfile.ts`).
 *
 * Fit numbers are absolute mm (printer tolerance does not scale with the model).
 * Shape scales with the limb.
 *
 * LOCKED: v2 passed its PLA print test (2026-11-07), bore printed hole-down.
 * prove-swivel-locked.mts fails if these numbers, the test pair, or a model
 * swivel cut change. v1 (0.2 mm lip, hole-up) popped out when twisted.
 */
export const SWIVEL_TEST = {
  /**
   * v1 (0.2 mm lip, bore printed hole-up) clicked in but popped out when twisted:
   * the lip's ledge was an overhang and printed rounded. v2 prints the bore
   * hole-down so the ledge is a crisp top layer, and deepens the lip.
   */
  version: 'v2',
  /** Collar radius — the round face both parts share at the cut. */
  collarRadius: 4,
  /** Material the post passes through before its lip snaps out behind it. */
  boreDepth: 2.6,
  postDiameter: 3,
  /** Hole Ø = post Ø + this. Small = stiffer turn. */
  holeClearance: 0.1,
  /** Radial lip on the post tip that snaps past the hole. */
  lipMm: 0.3,
  /** 45° chamfer at the hole's mouth: lead-in, and room for first-layer squish. */
  entryChamfer: 0.3,
  /** Tapered lead-in past the hole. */
  lipLength: 0.9,
  /** Lip shoulder sits this far short of the hole's end, so it clamps the collars together. */
  shoulderPreload: 0.05,
  /** Slot across the post so its two halves squeeze through the hole. */
  splitWidth: 0.7,
  /** Test pair only: length of each round body. */
  bodyLength: 8,
} as const

/** Below this the post is too thin to survive handling in PLA. */
export const MIN_RELIABLE_POST_DIAMETER_MM = 2.4

export type SwivelSpec = {
  collarRadius: number
  boreDepth: number
  postDiameter: number
  holeClearance: number
  lipMm: number
  lipLength: number
  shoulderPreload: number
  splitWidth: number
  entryChamfer: number
}

/**
 * Z positions in swivel-local space. The turn axis is Z, the collars meet at
 * z = 0; the bore part lies on −Z and the post points down into it.
 */
export function swivelLayout(S: SwivelSpec) {
  const postR = S.postDiameter / 2
  const shoulderZ = -(S.boreDepth - S.shoulderPreload)
  return {
    postR,
    holeR: postR + S.holeClearance / 2,
    lipR: postR + S.lipMm,
    shoulderZ,
    tipZ: shoulderZ - S.lipLength,
    /** Bottom of the pocket the lip opens into. */
    pocketZ: shoulderZ - S.lipLength - 0.4,
  }
}

export function swivelTestSpec(): SwivelSpec {
  return {
    collarRadius: SWIVEL_TEST.collarRadius,
    boreDepth: SWIVEL_TEST.boreDepth,
    postDiameter: SWIVEL_TEST.postDiameter,
    holeClearance: SWIVEL_TEST.holeClearance,
    lipMm: SWIVEL_TEST.lipMm,
    lipLength: SWIVEL_TEST.lipLength,
    shoulderPreload: SWIVEL_TEST.shoulderPreload,
    splitWidth: SWIVEL_TEST.splitWidth,
    entryChamfer: SWIVEL_TEST.entryChamfer,
  }
}

/**
 * Size the swivel to the room inside the limb at the cut (mm). Shape scales;
 * fit numbers (clearance, lip, preload, split) stay in mm so they match the
 * test print. Returns null when the limb can't hold even a minimal post.
 */
export function swivelDimsForRoom(roomMm: number): SwivelSpec | null {
  const collarRadius = roomMm * 0.92
  const s = collarRadius / SWIVEL_TEST.collarRadius
  const postDiameter = Math.min(SWIVEL_TEST.postDiameter * s, SWIVEL_TEST.postDiameter * 1.5)
  if (postDiameter < 1.4) return null
  return {
    collarRadius,
    boreDepth: Math.max(Math.min(SWIVEL_TEST.boreDepth * s, SWIVEL_TEST.boreDepth * 1.5), 1.2),
    postDiameter,
    holeClearance: SWIVEL_TEST.holeClearance,
    lipMm: Math.min(SWIVEL_TEST.lipMm, postDiameter * 0.1),
    lipLength: Math.max(Math.min(SWIVEL_TEST.lipLength * s, SWIVEL_TEST.lipLength * 1.5), 0.5),
    shoulderPreload: SWIVEL_TEST.shoulderPreload,
    splitWidth: Math.min(SWIVEL_TEST.splitWidth, postDiameter * 0.25),
    entryChamfer: Math.min(SWIVEL_TEST.entryChamfer, postDiameter * 0.1),
  }
}

export function scaleSwivelSpec(S: SwivelSpec, k: number): SwivelSpec {
  return {
    collarRadius: S.collarRadius * k,
    boreDepth: S.boreDepth * k,
    postDiameter: S.postDiameter * k,
    holeClearance: S.holeClearance * k,
    lipMm: S.lipMm * k,
    lipLength: S.lipLength * k,
    shoulderPreload: S.shoulderPreload * k,
    splitWidth: S.splitWidth * k,
    entryChamfer: S.entryChamfer * k,
  }
}
