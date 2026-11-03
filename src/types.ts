export type CutAxis = 'x' | 'y' | 'z'

export type FilamentType = 'pla' | 'pla_plus' | 'petg' | 'abs' | 'tpu'

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
}

export interface ModelInfo {
  name: string
  size: [number, number, number]
  triangles: number
}

export type ExportMode = 'cut' | 'cutters' | 'parts'
