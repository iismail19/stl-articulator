import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { CutAxis, Joint } from '../types'
import {
  BALL_STEM,
  computeBallStemDims,
  midStemPlacement,
} from './ballStemProfile'

/** Preview marker: limb-sized kerf disk + ball (matches cut / strength profile). */
export function createCutterGeometry(
  baseRadius: number,
  scale = 1,
): THREE.BufferGeometry {
  const dims = computeBallStemDims(Math.max(baseRadius * scale, 1e-4))
  const { r, ballR, stemR, stemH, ballChamferH, ballChamferWide, ballChamferNarrow, collarH } =
    dims
  const P = BALL_STEM
  const mid = midStemPlacement(dims)
  const diskR = r * 1.35
  const diskH = Math.max(r * 0.14, 1e-4)

  const ball = new THREE.SphereGeometry(ballR, 28, 20)
  ball.translate(0, -stemH, 0)

  const ballChamfer = new THREE.CylinderGeometry(
    ballChamferNarrow,
    ballChamferWide,
    ballChamferH,
    20,
  )
  const chamferY0 = -stemH + ballR * P.ballChamferStartOfBall
  ballChamfer.translate(0, chamferY0 + ballChamferH / 2, 0)

  const stem = new THREE.CylinderGeometry(stemR, stemR, mid.len, 20)
  stem.translate(0, mid.z0 + mid.len / 2, 0)

  const collar = new THREE.CylinderGeometry(
    stemR * P.collarWideOfStem,
    stemR * P.collarNarrowOfStem,
    collarH,
    20,
  )
  collar.translate(0, collarH * 0.38, 0)

  const disk = new THREE.CylinderGeometry(diskR, diskR, diskH, 40)
  const merged = mergeGeometries([ball, ballChamfer, stem, collar, disk], false)
  ball.dispose()
  ballChamfer.dispose()
  stem.dispose()
  collar.dispose()
  disk.dispose()
  const geo = merged ?? new THREE.SphereGeometry(ballR, 28, 20)
  geo.computeVertexNormals()
  return geo
}

/**
 * Three markers/hardware are built along +Y. Map +Y → same world axis as
 * Manifold's +Z mapping above (X was flipped +90 vs Manifold's +X — that made
 * arm balls attach to the empty side of the cut).
 */
export function cutterOrientation(axis: CutAxis, rotationDeg: number): THREE.Euler {
  const rot = THREE.MathUtils.degToRad(rotationDeg)
  switch (axis) {
    case 'x':
      // +Y → +X (was +PI/2 → −X, opposite of Manifold). ZYX so the twist spins
      // about the limb instead of tilting the cut plane.
      return new THREE.Euler(0, rot, -Math.PI / 2, 'ZYX')
    case 'y':
      return new THREE.Euler(0, rot, 0)
    case 'z':
      // +Y → +Z (was −PI/2 → −Z)
      return new THREE.Euler(Math.PI / 2, rot, 0)
  }
}

export function jointTilt(joint: Joint): [number, number, number] {
  return joint.tilt ?? [0, 0, 0]
}

/** Axis align, then world-space X/Y/Z tilt. */
export function jointStemQuaternion(joint: Joint): THREE.Quaternion {
  const q = new THREE.Quaternion().setFromEuler(
    cutterOrientation(joint.axis, joint.rotation),
  )
  const [tx, ty, tz] = jointTilt(joint)
  if (tx || ty || tz) {
    const qTilt = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(tx),
        THREE.MathUtils.degToRad(ty),
        THREE.MathUtils.degToRad(tz),
        'XYZ',
      ),
    )
    q.premultiply(qTilt)
  }
  return q
}

/** Unit stem / cut-plane normal in world space (local +Y after orientation). */
export function jointCutNormal(joint: Joint): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0).applyQuaternion(jointStemQuaternion(joint)).normalize()
}

/** Manifold solids are built along local +Z; preview markers along local +Y. */
const Z_TO_Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)

/**
 * Joint-local → world for Manifold solids (local +Z = stem = jointCutNormal).
 * Built from the same quaternion as the preview marker, so twist and
 * multi-axis tilt can't drift between what you see and what gets cut.
 * Column-major, ready for Manifold.transform.
 */
export function jointLocalToWorld(joint: Joint): THREE.Matrix4 {
  const q = jointStemQuaternion(joint).multiply(Z_TO_Y)
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...joint.position),
    q,
    new THREE.Vector3(1, 1, 1),
  )
}

/** World direction of the hinge pin (joint-local +Y in the cut frame). */
export function hingeAxisWorld(joint: Joint): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0).transformDirection(jointLocalToWorld(joint))
}

export interface FigureAxes {
  up: CutAxis
  /** Front-to-back — the direction knees and elbows bend. */
  depth: CutAxis
}

const Z_UP: FigureAxes = { up: 'z', depth: 'y' }

/** A standing figure is tallest along up and thinnest front-to-back. */
export function figureAxes(size: [number, number, number]): FigureAxes {
  const order = (['x', 'y', 'z'] as const)
    .map((a, i) => ({ a, v: size[i] }))
    .sort((p, q) => q.v - p.v)
  return { up: order[0].a, depth: order[2].a }
}

const AXIS_INDEX: Record<CutAxis, number> = { x: 0, y: 1, z: 2 }

function axisVec(a: CutAxis): THREE.Vector3 {
  return new THREE.Vector3().setComponent(AXIS_INDEX[a], 1)
}

/**
 * Twist that makes a hinge bend front-to-back, like a knee or elbow. A limb
 * that itself points front-to-back bends up/down instead.
 */
export function frontBackHingeTwist(joint: Joint, figure: FigureAxes = Z_UP): number {
  const limb = new THREE.Vector3(0, 0, 1).transformDirection(jointLocalToWorld(joint))
  const want =
    Math.abs(limb.getComponent(AXIS_INDEX[figure.depth])) > 0.7
      ? axisVec(figure.up)
      : axisVec(figure.depth)
  let best = 0
  let bestScore = -1
  for (const rotation of [0, 90, 180, 270]) {
    const bend = new THREE.Vector3(1, 0, 0).transformDirection(
      jointLocalToWorld({ ...joint, rotation }),
    )
    const score = Math.abs(bend.dot(want))
    if (score > bestScore + 1e-6) {
      best = rotation
      bestScore = score
    }
  }
  return best
}

export function applyJointTransform(
  mesh: THREE.Object3D,
  joint: Joint,
  baseRadius: number,
): void {
  mesh.position.set(...joint.position)
  mesh.quaternion.copy(jointStemQuaternion(joint))
  mesh.rotation.setFromQuaternion(mesh.quaternion)
  const s = Math.max(joint.scale, 0.05)
  mesh.scale.setScalar(baseRadius * s)
}

export function createPreviewRingGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.TorusGeometry(radius, radius * 0.08, 12, 48)
}

export function ringOrientation(axis: CutAxis, rotationDeg: number): THREE.Euler {
  const rot = THREE.MathUtils.degToRad(rotationDeg)
  switch (axis) {
    case 'x':
      return new THREE.Euler(0, Math.PI / 2, rot)
    case 'y':
      return new THREE.Euler(Math.PI / 2, 0, rot)
    case 'z':
      return new THREE.Euler(0, 0, rot)
  }
}

export function ringQuaternion(joint: Joint): THREE.Quaternion {
  const q = new THREE.Quaternion().setFromEuler(
    ringOrientation(joint.axis, joint.rotation),
  )
  const [tx, ty, tz] = jointTilt(joint)
  if (tx || ty || tz) {
    const qTilt = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(tx),
        THREE.MathUtils.degToRad(ty),
        THREE.MathUtils.degToRad(tz),
        'XYZ',
      ),
    )
    q.premultiply(qTilt)
  }
  return q
}
