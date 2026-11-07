import * as THREE from 'three'
import type { CutAxis, JointKind } from '../types'
import type { FigureAxes } from './cutterGeometry'
import {
  figureAxesOf,
  measureClearanceRadius,
  recenterInLimb,
  type LocalJointHint,
  type ProbeMesh,
} from './meshProbe'

/**
 * Auto-Suggest for standing figures: one marker per anatomical joint instead of
 * scattering markers on every thin spot.
 *
 * Spots are fractions of the model's bounding box, taken from joints placed by
 * hand on Dag (big head, short limbs): `side` = across the shoulders from the
 * middle (±), `height` = from the feet up. Each seed then snaps onto the limb
 * actually there, so slightly different proportions still land on the limb.
 */
export interface TemplateSpot {
  name: string
  kind: JointKind
  /** Cut runs along the body's up axis (neck, elbows, knees) or across it (shoulders). */
  along: 'up' | 'side'
  side: number
  height: number
}

export const FIGURE_TEMPLATE: TemplateSpot[] = [
  { name: 'neck', kind: 'ball', along: 'up', side: 0, height: 0.6 },
  { name: 'shoulder', kind: 'ball', along: 'side', side: -0.2, height: 0.53 },
  { name: 'shoulder', kind: 'ball', along: 'side', side: 0.2, height: 0.53 },
  { name: 'elbow', kind: 'knuckle', along: 'up', side: -0.345, height: 0.4 },
  { name: 'elbow', kind: 'knuckle', along: 'up', side: 0.345, height: 0.4 },
  { name: 'knee', kind: 'knuckle', along: 'up', side: -0.165, height: 0.215 },
  { name: 'knee', kind: 'knuckle', along: 'up', side: 0.165, height: 0.215 },
]

export interface FigureHint extends LocalJointHint {
  name: string
  kind: JointKind
}

const IDX: Record<CutAxis, number> = { x: 0, y: 1, z: 2 }

function sideAxisOf(f: FigureAxes): CutAxis {
  return (['x', 'y', 'z'] as const).find((a) => a !== f.up && a !== f.depth)!
}

/** Middle of the solid along the front-to-back line through (side, up), or null if it misses. */
function throughDepth(
  mesh: ProbeMesh,
  base: THREE.Vector3,
  depth: CutAxis,
  box: THREE.Box3,
): THREE.Vector3 | null {
  const d = IDX[depth]
  const span = box.max.getComponent(d) - box.min.getComponent(d)
  const origin = base.clone().setComponent(d, box.min.getComponent(d) - span * 0.1)
  const dir = new THREE.Vector3().setComponent(d, 1)
  const ray = new THREE.Raycaster(origin, dir, 0, span * 1.2)
  const hits = ray.intersectObject(mesh, false)
  if (hits.length < 2) return null
  return hits[0].point.clone().lerp(hits[hits.length - 1].point, 0.5)
}

export function suggestFigureJoints(mesh: ProbeMesh, modelSize: number): FigureHint[] {
  const geo = mesh.geometry
  if (!geo.boundingBox) geo.computeBoundingBox()
  const box = geo.boundingBox!
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const figure = figureAxesOf(geo)
  const sideAxis = sideAxisOf(figure)
  const si = IDX[sideAxis]
  const ui = IDX[figure.up]
  const sideSize = size.getComponent(si)

  const out: FigureHint[] = []
  for (const spot of FIGURE_TEMPLATE) {
    const seed = center.clone()
    seed.setComponent(ui, box.min.getComponent(ui) + size.getComponent(ui) * spot.height)
    // Nudge sideways until the front-to-back line actually goes through the limb.
    let inside: THREE.Vector3 | null = null
    for (const nudge of [0, -0.03, 0.03, -0.06, 0.06]) {
      const s = seed.clone()
      s.setComponent(si, center.getComponent(si) + (spot.side + Math.sign(spot.side) * nudge) * sideSize)
      inside = throughDepth(mesh, s, figure.depth, box)
      if (inside) break
    }
    if (!inside) continue

    const axis: CutAxis = spot.along === 'up' ? figure.up : sideAxis
    const centered = recenterInLimb(mesh, inside, axis, modelSize)
    // Keep the template's height (and the shoulder line); take the limb's middle otherwise.
    const p = centered.clone()
    p.setComponent(ui, inside.getComponent(ui))
    if (spot.along === 'side') p.setComponent(si, inside.getComponent(si))
    const radius = measureClearanceRadius(mesh, p, axis, modelSize)
    out.push({
      name: spot.name,
      kind: spot.kind,
      position: [p.x, p.y, p.z],
      axis,
      radius,
      diameter: radius * 2,
      figure,
    })
  }
  return out
}
