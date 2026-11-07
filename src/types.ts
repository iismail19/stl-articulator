export type CutAxis = 'x' | 'y' | 'z'

export type FilamentType = 'pla' | 'pla_plus' | 'petg' | 'abs' | 'tpu'

/** How the two parts connect after the kerf. */
export type JointKind = 'ball' | 'hinge' | 'knuckle' | 'swivel' | 'universal'

export interface Joint {
  id: number
  position: [number, number, number]
  axis: CutAxis
  /** Relative scale of the cutter (1 = base radius). */
  scale: number
  /** Twist around the cut axis, in degrees. */
  rotation: number
  /**
   * Extra world-space tilt in degrees [X, Y, Z].
   * Use to aim the stem along angled arms / wrists / ankles.
   */
  tilt: [number, number, number]
  /**
   * Articulation style. Missing on older saves → ball. All kinds are selectable;
   * `tested` on the profile is a print-status label only.
   */
  kind?: JointKind
  /**
   * Trade which part gets the socket / hole / fork and which gets the
   * ball / peg / tongue, versus the automatic choice. Missing → automatic.
   */
  swapSides?: boolean
}

export interface ModelInfo {
  name: string
  size: [number, number, number]
  triangles: number
}

export type ExportMode = 'cut' | 'cutters' | 'parts'
