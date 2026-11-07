import * as THREE from 'three'
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh'
import type { CutAxis, Joint, JointKind } from '../types'
import { bendsOnOneAxis, DEFAULT_JOINT_KIND } from './jointKinds'
import {
  figureAxes,
  frontBackHingeTwist,
  jointCutNormal,
  type FigureAxes,
} from './cutterGeometry'

type GeoWithBVH = THREE.BufferGeometry & {
  computeBoundsTree?: (options?: object) => void
  disposeBoundsTree?: () => void
  boundsTree?: unknown
}

const gProto = THREE.BufferGeometry.prototype as GeoWithBVH
if (!gProto.computeBoundsTree) {
  gProto.computeBoundsTree = computeBoundsTree as unknown as GeoWithBVH['computeBoundsTree']
  gProto.disposeBoundsTree = disposeBoundsTree as unknown as GeoWithBVH['disposeBoundsTree']
}
THREE.Mesh.prototype.raycast = acceleratedRaycast

export type ProbeMesh = THREE.Mesh

export function prepareProbeMesh(geometry: THREE.BufferGeometry): ProbeMesh {
  const geo = geometry as GeoWithBVH
  if (!geo.boundsTree) geo.computeBoundsTree?.()
  // DoubleSide: joint origins sit inside the solid; FrontSide rays never hit and
  // clearance collapses to the floor → kerfs too small to sever limbs.
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  )
  mesh.updateMatrixWorld(true)
  return mesh
}

export function disposeProbeGeometry(geometry: THREE.BufferGeometry) {
  ;(geometry as GeoWithBVH).disposeBoundsTree?.()
}

function extentAlong(
  mesh: ProbeMesh,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  missIsLong = false,
): number {
  const raycaster = new THREE.Raycaster()
  ;(raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
  raycaster.far = maxDist

  const d = dir.clone().normalize()
  raycaster.set(origin, d)
  const hitA = raycaster.intersectObject(mesh, false)
  raycaster.set(origin, d.clone().negate())
  const hitB = raycaster.intersectObject(mesh, false)

  const a = hitA[0]?.distance
  const b = hitB[0]?.distance
  if (missIsLong) {
    if (a == null && b == null) return 0
    return (a ?? maxDist) + (b ?? maxDist)
  }
  if (a == null || b == null) return 0
  return a + b
}

/** Figure axes from the model's bounding box: tallest side is up, thinnest is front-to-back. */
export function figureAxesOf(geometry: THREE.BufferGeometry): FigureAxes {
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const s = new THREE.Vector3()
  geometry.boundingBox!.getSize(s)
  return figureAxes([s.x, s.y, s.z])
}

function hitDistance(
  mesh: ProbeMesh,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
): number {
  const raycaster = new THREE.Raycaster()
  ;(raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
  raycaster.far = maxDist
  raycaster.set(origin, dir.clone().normalize())
  const hits = raycaster.intersectObject(mesh, false)
  return hits[0]?.distance ?? 0
}

const AXIS_VEC: Record<CutAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

function perpBasis(axis: CutAxis): [THREE.Vector3, THREE.Vector3] {
  switch (axis) {
    case 'x':
      return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
    case 'y':
      return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)]
    case 'z':
      return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]
  }
}

function perpBasisFromNormal(normal: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const n = normal.clone().normalize()
  const tmp = Math.abs(n.y) < 0.85 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(n, tmp).normalize()
  const v = new THREE.Vector3().crossVectors(n, u).normalize()
  return [u, v]
}

/**
 * Move a joint origin to the center of the local limb cross-section.
 * Surface-snapped clicks sit near the skin; a disk there can't reach the far side.
 * Pass `normal` (stem direction) for tilted joints; otherwise uses cardinal `axis`.
 */
export function recenterInLimb(
  mesh: ProbeMesh,
  origin: THREE.Vector3,
  axis: CutAxis,
  modelSize: number,
  normal?: THREE.Vector3,
): THREE.Vector3 {
  // Heads/torsos need a longer probe than wrists — 0.12 undershot Dag's neck
  const maxDist = Math.max(modelSize * 0.22, 1e-4)
  const [u, v] = normal ? perpBasisFromNormal(normal) : perpBasis(axis)
  let cur = origin.clone()
  // 2 passes: wrists/ankles often start on the skin — one pass undershoots
  for (let pass = 0; pass < 2; pass++) {
    const mids: THREE.Vector3[] = []
    const steps = 20
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI
      const dir = u
        .clone()
        .multiplyScalar(Math.cos(a))
        .addScaledVector(v, Math.sin(a))
        .normalize()
      const dPos = hitDistance(mesh, cur, dir, maxDist)
      const dNeg = hitDistance(mesh, cur, dir.clone().negate(), maxDist)
      if (dPos > 0 && dNeg > 0) {
        mids.push(cur.clone().addScaledVector(dir, (dPos - dNeg) * 0.5))
      }
    }
    if (mids.length < 3) break
    const c = new THREE.Vector3()
    for (const m of mids) c.add(m)
    cur = c.multiplyScalar(1 / mids.length)
  }
  return cur
}

/**
 * Radius needed for a kerf disk to clear the limb at `origin`.
 * Uses bidirectional half-widths + high local percentile so the disk actually severs.
 */
export function measureClearanceRadius(
  mesh: ProbeMesh,
  origin: THREE.Vector3,
  axis: CutAxis,
  modelSize: number,
  normal?: THREE.Vector3,
): number {
  // Keep probes local — long rays into the chest caused the giant pink/purple spheres
  const maxDist = Math.max(modelSize * 0.12, 1e-4)
  const [u, v] = normal ? perpBasisFromNormal(normal) : perpBasis(axis)
  const halfWidths: number[] = []
  const steps = 24
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI
    const dir = u
      .clone()
      .multiplyScalar(Math.cos(a))
      .addScaledVector(v, Math.sin(a))
      .normalize()
    const width = extentAlong(mesh, origin, dir, maxDist)
    if (width > 0) halfWidths.push(width * 0.5)
  }

  let r: number
  if (halfWidths.length >= 4) {
    halfWidths.sort((a, b) => a - b)
    const median = halfWidths[Math.floor(halfWidths.length / 2)]
    // Drop torso-spiking chords; keep enough to clear the limb silhouette
    const cluster = halfWidths.filter((h) => h <= median * 2.4)
    const use = cluster.length >= 3 ? cluster : halfWidths
    const p90 = use[Math.min(use.length - 1, Math.floor(use.length * 0.9))]
    r = p90 * 1.2
  } else {
    r =
      Math.max(
        extentAlong(mesh, origin, u, maxDist),
        extentAlong(mesh, origin, v, maxDist),
      ) * 0.55
  }

  const lo = modelSize * 0.02
  // Arms glued to the torso need a wider kerf than a free-standing limb
  const hi = modelSize * 0.18
  return Math.min(Math.max(r, lo), hi)
}

export interface LocalJointHint {
  position: [number, number, number]
  axis: CutAxis
  /** Kerf / ring radius in world units (must clear the limb). */
  radius: number
  diameter: number
  /** Which way the model stands — aims hinge/knuckle bends front-to-back. */
  figure?: FigureAxes
}

/**
 * Probe a click: pick limb axis, measure how wide the kerf must be to sever.
 */
export function probeJointAtPoint(
  mesh: ProbeMesh,
  point: THREE.Vector3,
  normal: THREE.Vector3,
  modelSize: number,
): LocalJointHint {
  const maxDist = Math.max(modelSize * 0.14, 1e-4)
  const inward = Math.max(modelSize * 0.012, 1e-5)
  const n = normal.clone().normalize()
  const origin = point.clone().addScaledVector(n, -inward)

  // Z-up models keep the original probe exactly. Other exports (e.g. Y-up) prefer
  // their own up axis, and a ray that runs out of range means the limb keeps going.
  const figure = figureAxesOf(mesh.geometry)
  const zUp = figure.up === 'z'
  const extents: Record<CutAxis, number> = {
    x: extentAlong(mesh, origin, AXIS_VEC.x, maxDist, !zUp),
    y: extentAlong(mesh, origin, AXIS_VEC.y, maxDist, !zUp),
    z: extentAlong(mesh, origin, AXIS_VEC.z, maxDist, !zUp),
  }

  // Along-limb = longest local tunnel. Soft-prefer the up axis when close —
  // hanging arms and legs run along it.
  let axis: CutAxis = figure.up
  let best = -1
  for (const a of ['x', 'y', 'z'] as CutAxis[]) {
    // A limb's skin faces sideways from its length, so the axis you clicked
    // along only measures the limb's thickness.
    const facing = !zUp && Math.abs(n.getComponent('xyz'.indexOf(a))) > 0.7 ? 0.5 : 1
    const score = extents[a] * (a === figure.up ? 1.12 : 1) * facing
    if (score > best) {
      best = score
      axis = a
    }
  }

  // Measure size at limb center, but KEEP click position near the cut/skin.
  // Moving the joint into the limb mid-point made sockets miss the cut face.
  const centered = recenterInLimb(mesh, origin, axis, modelSize)
  const radius = measureClearanceRadius(mesh, centered, axis, modelSize)

  return {
    position: [origin.x, origin.y, origin.z],
    axis,
    radius,
    diameter: radius * 2,
    figure,
  }
}

/**
 * Re-measure every joint so orange rings wrap through the limb before cutting.
 */
export function refitJointsToLimbs(
  mesh: ProbeMesh,
  joints: Joint[],
  baseRadius: number,
  modelSize: number,
): Joint[] {
  // Allow larger kerfs for limbs fused to the torso (Dag-style armpits)
  const maxScale = Math.min(3.2, (modelSize * 0.16) / Math.max(baseRadius, 1e-9))
  return joints.map((j) => {
    const origin = new THREE.Vector3(...j.position)
    const normal = jointCutNormal({ ...j, tilt: j.tilt ?? [0, 0, 0] })
    // Size from a centered probe, but do not move the joint (cut-face position)
    const centered = recenterInLimb(mesh, origin, j.axis, modelSize, normal)
    const radius = measureClearanceRadius(mesh, centered, j.axis, modelSize, normal)
    const scale = Math.min(
      Math.max(radius / Math.max(baseRadius, 1e-9), 0.2),
      maxScale,
    )
    return {
      ...j,
      kind: j.kind,
      tilt: j.tilt ?? [0, 0, 0],
      scale,
    }
  })
}

export function hintToJoint(
  hint: LocalJointHint,
  id: number,
  baseRadius: number,
  kind: JointKind = DEFAULT_JOINT_KIND,
): Joint {
  const scale = Math.max(hint.radius / Math.max(baseRadius, 1e-9), 0.2)
  const joint: Joint = {
    id,
    position: hint.position,
    axis: hint.axis,
    scale: Math.min(scale, 3.2),
    rotation: 0,
    tilt: [0, 0, 0],
    kind,
  }
  if (bendsOnOneAxis(kind)) joint.rotation = frontBackHingeTwist(joint, hint.figure)
  return joint
}

/** Gentle enlarge for retry — never runaway blob sizes. */
export function enlargeJoints(
  joints: Joint[],
  factor = 1.15,
  absoluteMaxScale = 2.4,
): Joint[] {
  return joints.map((j) => ({
    ...j,
    scale: Math.min(j.scale * factor, absoluteMaxScale),
  }))
}

/** Clamp every joint scale to a limb-safe maximum. */
export function clampJointScales(joints: Joint[], maxScale: number): Joint[] {
  return joints.map((j) => ({
    ...j,
    scale: Math.min(Math.max(j.scale, 0.25), maxScale),
  }))
}
