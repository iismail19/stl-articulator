import * as THREE from 'three'
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh'
import type { CutAxis, Joint } from '../types'
import { jointCutNormal } from './cutterGeometry'

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
  if (a == null || b == null) return 0
  return a + b
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

  const extents: Record<CutAxis, number> = {
    x: extentAlong(mesh, origin, AXIS_VEC.x, maxDist),
    y: extentAlong(mesh, origin, AXIS_VEC.y, maxDist),
    z: extentAlong(mesh, origin, AXIS_VEC.z, maxDist),
  }

  // Along-limb = longest local tunnel. Soft-prefer Z (STL up) when close — the
  // engine's neck and hanging-limb rules are Z-up.
  let axis: CutAxis = 'z'
  let best = -1
  for (const a of ['x', 'y', 'z'] as CutAxis[]) {
    const score = extents[a] * (a === 'z' ? 1.12 : 1)
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
      tilt: j.tilt ?? [0, 0, 0],
      scale,
    }
  })
}

function sampleSurfacePoints(
  geometry: THREE.BufferGeometry,
  count: number,
): { point: THREE.Vector3; normal: THREE.Vector3 }[] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const index = geometry.getIndex()
  const triCount = index ? index.count / 3 : pos.count / 3
  const out: { point: THREE.Vector3; normal: THREE.Vector3 }[] = []
  if (triCount < 1) return out

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const n = new THREE.Vector3()

  for (let i = 0; i < count; i++) {
    const t = Math.floor(Math.random() * triCount)
    let i0: number
    let i1: number
    let i2: number
    if (index) {
      i0 = index.getX(t * 3)
      i1 = index.getX(t * 3 + 1)
      i2 = index.getX(t * 3 + 2)
    } else {
      i0 = t * 3
      i1 = t * 3 + 1
      i2 = t * 3 + 2
    }
    a.fromBufferAttribute(pos, i0)
    b.fromBufferAttribute(pos, i1)
    c.fromBufferAttribute(pos, i2)
    let u = Math.random()
    let v = Math.random()
    if (u + v > 1) {
      u = 1 - u
      v = 1 - v
    }
    const point = a
      .clone()
      .multiplyScalar(1 - u - v)
      .addScaledVector(b, u)
      .addScaledVector(c, v)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    n.crossVectors(ab, ac).normalize()
    if (n.lengthSq() < 1e-10) continue
    out.push({ point, normal: n.clone() })
  }
  return out
}

export interface SuggestOptions {
  maxJoints?: number
  onProgress?: (label: string) => void
}

export async function suggestJoints(
  mesh: ProbeMesh,
  modelSize: number,
  opts: SuggestOptions = {},
): Promise<LocalJointHint[]> {
  const maxJoints = opts.maxJoints ?? 10
  opts.onProgress?.('Sampling surface for thin spots…')
  await new Promise((r) => setTimeout(r, 0))

  const samples = sampleSurfacePoints(mesh.geometry, 400)
  type Cand = LocalJointHint & { score: number }
  const cands: Cand[] = []

  for (let i = 0; i < samples.length; i++) {
    if (i % 80 === 0) {
      opts.onProgress?.(`Probing thin spots… ${Math.round((i / samples.length) * 100)}%`)
      await new Promise((r) => setTimeout(r, 0))
    }
    const { point, normal } = samples[i]
    const hint = probeJointAtPoint(mesh, point, normal, modelSize)
    cands.push({ ...hint, score: hint.diameter })
  }

  if (cands.length === 0) {
    opts.onProgress?.('Using bounding-box fallback spots…')
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!
    const c = new THREE.Vector3()
    box.getCenter(c)
    const size = new THREE.Vector3()
    box.getSize(size)
    // Anatomical defaults matching typical figure screenshots (Z-up figures)
    const fallbackAxes: { axis: CutAxis; p: THREE.Vector3; n: THREE.Vector3 }[] = [
      // neck
      {
        axis: 'z',
        p: new THREE.Vector3(c.x, c.y, box.min.z + size.z * 0.82),
        n: new THREE.Vector3(0, 1, 0),
      },
      // shoulders
      {
        axis: 'x',
        p: new THREE.Vector3(box.min.x + size.x * 0.22, c.y, box.min.z + size.z * 0.68),
        n: new THREE.Vector3(1, 0, 0),
      },
      {
        axis: 'x',
        p: new THREE.Vector3(box.min.x + size.x * 0.78, c.y, box.min.z + size.z * 0.68),
        n: new THREE.Vector3(-1, 0, 0),
      },
      // elbows
      {
        axis: 'x',
        p: new THREE.Vector3(box.min.x + size.x * 0.12, c.y, box.min.z + size.z * 0.5),
        n: new THREE.Vector3(1, 0, 0),
      },
      {
        axis: 'x',
        p: new THREE.Vector3(box.min.x + size.x * 0.88, c.y, box.min.z + size.z * 0.5),
        n: new THREE.Vector3(-1, 0, 0),
      },
      // hips
      {
        axis: 'z',
        p: new THREE.Vector3(box.min.x + size.x * 0.38, c.y, box.min.z + size.z * 0.32),
        n: new THREE.Vector3(0, 1, 0),
      },
      {
        axis: 'z',
        p: new THREE.Vector3(box.min.x + size.x * 0.62, c.y, box.min.z + size.z * 0.32),
        n: new THREE.Vector3(0, 1, 0),
      },
      // ankles
      {
        axis: 'z',
        p: new THREE.Vector3(box.min.x + size.x * 0.38, c.y, box.min.z + size.z * 0.12),
        n: new THREE.Vector3(0, 1, 0),
      },
      {
        axis: 'z',
        p: new THREE.Vector3(box.min.x + size.x * 0.62, c.y, box.min.z + size.z * 0.12),
        n: new THREE.Vector3(0, 1, 0),
      },
    ]
    for (const f of fallbackAxes) {
      const hint = probeJointAtPoint(mesh, f.p, f.n, modelSize)
      cands.push({
        ...hint,
        axis: f.axis,
        position: [f.p.x, f.p.y, f.p.z],
        score: hint.diameter,
      })
    }
  }

  cands.sort((a, b) => a.score - b.score)
  const median = cands[Math.floor(cands.length / 2)]?.score ?? modelSize
  const thin = cands.filter((c) => c.score <= median * 1.05)

  const picked: LocalJointHint[] = []
  const minSep = modelSize * 0.1

  for (const c of thin.length ? thin : cands) {
    if (picked.length >= maxJoints) break
    const tooClose = picked.some((p) => {
      const dx = p.position[0] - c.position[0]
      const dy = p.position[1] - c.position[1]
      const dz = p.position[2] - c.position[2]
      return Math.hypot(dx, dy, dz) < minSep
    })
    if (tooClose) continue
    picked.push({
      position: c.position,
      axis: c.axis,
      radius: c.radius,
      diameter: c.diameter,
    })
  }

  return picked
}

export function hintToJoint(
  hint: LocalJointHint,
  id: number,
  baseRadius: number,
): Joint {
  const scale = Math.max(hint.radius / Math.max(baseRadius, 1e-9), 0.2)
  return {
    id,
    position: hint.position,
    axis: hint.axis,
    scale: Math.min(scale, 3.2),
    rotation: 0,
    tilt: [0, 0, 0],
  }
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
