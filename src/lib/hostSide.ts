import * as THREE from 'three'
import type { CutAxis, Joint } from '../types'
import { jointCutNormal, type FigureAxes } from './cutterGeometry'

/** +1 / −1: which side of the cut normal holds the socket / hole / fork part. */
export type SocketSide = 1 | -1

const Z_UP: FigureAxes = { up: 'z', depth: 'y' }
const INDEX: Record<CutAxis, number> = { x: 0, y: 1, z: 2 }

/**
 * The ball is print-tested and locked to the original Z-up host rules
 * (prove-ball-locked.mts); only the newer kinds follow the figure's real up axis.
 */
export function hostFigure(kind: Joint['kind'], figure: FigureAxes): FigureAxes {
  return kind == null || kind === 'ball' ? Z_UP : figure
}

/** Left-right axis: the one that is neither up nor front-to-back. */
function sideIndex(figure: FigureAxes): number {
  return 3 - INDEX[figure.up] - INDEX[figure.depth]
}

/** Figures are centered on load: a cut along up near the midline is the neck/waist. */
export function isNeckJoint(joint: Joint, modelSize: number, figure: FigureAxes = Z_UP): boolean {
  return (
    joint.axis === figure.up && Math.abs(joint.position[sideIndex(figure)]) < modelSize * 0.08
  )
}

/** True for elbow/ankle-style joints that sit below a same-axis shoulder/hip. */
export function isDistalLimbJoint(
  joint: Joint,
  all: Joint[],
  modelSize: number,
  figure: FigureAxes = Z_UP,
): boolean {
  if (joint.axis === figure.up) return false
  const s = sideIndex(figure)
  const u = INDEX[figure.up]
  return all.some((other) => {
    if (other.id === joint.id || other.axis !== joint.axis) return false
    const sameSide = Math.sign(other.position[s] || 1e-9) === Math.sign(joint.position[s] || 1e-9)
    return sameSide && other.position[u] > joint.position[u] + modelSize * 0.05
  })
}

/**
 * The engine's host rule, guessed from the marker alone (no cut yet):
 *   neck → socket in the upper part; along up / distal → socket in the lower
 *   part; otherwise → socket in the bigger part, taken as the side facing the
 *   model center. Flip 180° trades it.
 */
export function predictSocketSide(
  joint: Joint,
  all: Joint[],
  modelSize: number,
  modelFigure: FigureAxes = Z_UP,
): SocketSide {
  const figure = hostFigure(joint.kind, modelFigure)
  const n = jointCutNormal(joint)
  const up = n.getComponent(INDEX[figure.up])
  let side: SocketSide
  if (isNeckJoint(joint, modelSize, figure)) side = up >= 0 ? 1 : -1
  else if (joint.axis === figure.up || isDistalLimbJoint(joint, all, modelSize, figure)) {
    side = up <= 0 ? 1 : -1
  } else {
    const toCenter = new THREE.Vector3(...joint.position).negate()
    side = n.dot(toCenter) >= 0 ? 1 : -1
  }
  return joint.swapSides ? (-side as SocketSide) : side
}

/** Changes to any of these can move the engine's choice; anything else can't. */
export function socketSideKey(joint: Joint): string {
  return JSON.stringify([joint.position, joint.axis, joint.rotation, joint.tilt, joint.kind, !!joint.swapSides])
}
