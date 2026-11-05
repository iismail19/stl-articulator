import Module from 'manifold-3d'
import type { Mat4, ManifoldToplevel } from 'manifold-3d'
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Joint } from '../types'
import { cutWithBvhCsg } from './bvhFallback'
import {
  BALL_STEM,
  computeBallStemDims,
  type BallStemDims,
} from './ballStemProfile'
import { jointLocalToWorld } from './cutterGeometry'
import {
  DEFAULT_FILAMENT,
  getFilamentProfile,
  MIN_RELIABLE_BALL_DIAMETER_MM,
  socketRadialDims,
  type FilamentProfile,
  type FilamentType,
} from './filamentProfiles'
import { splitConnectedComponents } from './splitMesh'

export type { FilamentType }

type ManifoldApi = ManifoldToplevel
type ManifoldSolid = ReturnType<ManifoldApi['Manifold']['sphere']>

let wasmPromise: Promise<ManifoldApi> | null = null

export async function getManifold(): Promise<ManifoldApi> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const wasm = await Module()
      wasm.setup()
      return wasm
    })()
  }
  return wasmPromise
}

function deleteSafe(obj: { delete: () => void } | null | undefined) {
  try {
    obj?.delete()
  } catch {
    /* already deleted */
  }
}

function geometryToManifoldMesh(
  geometry: THREE.BufferGeometry,
  Mesh: ManifoldApi['Mesh'],
  mergeTol: number,
) {
  let geo = geometry.clone()
  geo = mergeVertices(geo, mergeTol)
  if (!geo.getIndex()) {
    const pos = geo.getAttribute('position')
    const idx = new Uint32Array(pos.count)
    for (let i = 0; i < pos.count; i++) idx[i] = i
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
  }

  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const index = geo.getIndex()!
  const vertProperties = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    vertProperties[i * 3] = pos.getX(i)
    vertProperties[i * 3 + 1] = pos.getY(i)
    vertProperties[i * 3 + 2] = pos.getZ(i)
  }
  const triVerts = new Uint32Array(index.array as ArrayLike<number>)

  const mesh = new Mesh({
    numProp: 3,
    vertProperties,
    triVerts,
  })
  mesh.merge()
  geo.dispose()
  return mesh
}

export function manifoldToGeometry(solid: ManifoldSolid): THREE.BufferGeometry {
  const out = solid.getMesh()
  const numProp = out.numProp
  const positions = new Float32Array(out.numVert * 3)
  for (let i = 0; i < out.numVert; i++) {
    positions[i * 3] = out.vertProperties[i * numProp]
    positions[i * 3 + 1] = out.vertProperties[i * numProp + 1]
    positions[i * 3 + 2] = out.vertProperties[i * numProp + 2]
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(out.triVerts), 1))
  geo.computeVertexNormals()
  return geo
}

function jointWorldRadius(baseRadius: number, joint: Joint): number {
  return Math.max(baseRadius * Math.max(joint.scale, 0.05), 1e-6)
}

/** Place cutter/ball/socket — Manifold +Z stem, same world axis as preview arrow. */
function placeAlongAxis(solid: ManifoldSolid, joint: Joint): ManifoldSolid {
  const placed = solid.transform(jointLocalToWorld(joint).elements as unknown as Mat4)
  deleteSafe(solid)
  return placed
}

/**
 * Finite kerf at a joint. Ball/socket size stays on `joint.scale`; the kerf
 * shape is separate so a fat armpit clearance doesn't delete the upper arm.
 */
function createKerfDisk(
  Manifold: ManifoldApi['Manifold'],
  radius: number,
  joint: Joint,
  opts: { mode?: 'primary' | 'distal'; host?: ManifoldSolid; neck?: boolean } = {},
): ManifoldSolid {
  const r = jointWorldRadius(radius, joint)
  const mode = opts.mode ?? 'primary'

  // Neck: wide disk + square slab — collar webbing sits in XY.
  // Off-center Z cuts (elbows/wrists) get the plain disk so the slab can't bite the hips.
  if (joint.axis === 'z') {
    const diskH = Math.max(r * 0.36, 1e-6)
    const diskR = r * 1.75
    const disk = Manifold.cylinder(diskH, diskR, -1, 48, true)
    if (!opts.neck) return placeAlongAxis(disk, joint)
    const slab = Manifold.cube([diskR * 2.6, diskR * 2.6, diskH * 1.15], true)
    try {
      const united = Manifold.union([disk, slab])
      deleteSafe(disk)
      deleteSafe(slab)
      return placeAlongAxis(united, joint)
    } catch {
      deleteSafe(slab)
      return placeAlongAxis(disk, joint)
    }
  }

  // Distal (elbow): guillotine at the elbow.
  //  - Torso-sized host: big disk + slab (free a fused hand)
  //  - Limb-sized host: modest disk only (don't vaporize a short arm)
  if (mode === 'distal') {
    const hostVol = opts.host ? solidVolume(opts.host) : 0
    const torsoLike = hostVol > r * r * r * 80 // Dag torso ≫ arm stubs in norm space
    const diskR = torsoLike ? r * 1.6 : r * 1.05
    const diskH = Math.max(r * (torsoLike ? 0.32 : 0.22), 0.35)
    const disk = Manifold.cylinder(diskH, diskR, -1, 40, true)
    if (!torsoLike) return placeAlongAxis(disk, joint)
    const slab = Manifold.cube([diskR * 2.3, diskR * 2.3, diskH * 1.1], true)
    try {
      const united = Manifold.union([disk, slab])
      deleteSafe(disk)
      deleteSafe(slab)
      return placeAlongAxis(united, joint)
    } catch {
      deleteSafe(slab)
      return placeAlongAxis(disk, joint)
    }
  }

  // Shoulder/hip primary: full disk so armpit blends actually sever.
  // Elbows are NOT cut in this pass — they run later as a thin guillotine on
  // the isolated arm solid, so overlapping kerfs can't delete the upper arm.
  const diskH = Math.max(r * 0.36, 1e-6)
  const diskR = r * 1.55
  const disk = Manifold.cylinder(diskH, diskR, -1, 48, true)
  return placeAlongAxis(disk, joint)
}

/**
 * Ball on a stem, protruding from the +side toward the −side socket.
 * Local +Z == +cut-axis after placeAlongAxis.
 * Dims come from ballStemProfile so cuts match preview + PLA test STLs.
 */
function ballStemDims(radius: number, joint: Joint) {
  return computeBallStemDims(jointWorldRadius(radius, joint))
}

/**
 * Where a joint's ball/socket sit along the local stem axis.
 * Local frame: cut plane at z=0, ball host on +Z, socket host on −Z.
 */
type JointSeat = {
  /** Ball (and socket sphere) center — negative, inside the socket host */
  centerZ: number
  /** Ball-host cut face (≥ 0) */
  faceB: number
  /** Socket-host cut face (≤ 0) */
  faceS: number
}

function defaultSeat(dims: BallStemDims): JointSeat {
  const kerfHalf = dims.r * 0.18
  return { centerZ: dims.ballZ, faceB: kerfHalf, faceS: -kerfHalf }
}

/** Ball + stem in the joint-local frame (root grows into +Z, ball toward −Z). */
function createBallLocal(
  Manifold: ManifoldApi['Manifold'],
  dims: BallStemDims,
  seat: JointSeat,
): ManifoldSolid {
  const { ballR, stemR, embed, ballChamferH, ballChamferWide, ballChamferNarrow, collarH, stepH } =
    dims
  const P = BALL_STEM
  const { centerZ, faceB } = seat

  const ballRaw = Manifold.sphere(ballR, 40)
  const ball = ballRaw.translate([0, 0, centerZ])
  deleteSafe(ballRaw)

  // VISIBLE chamfer on the ball: fat cone sitting ON the sphere (not buried inside)
  const chamferZ0 = centerZ + ballR * P.ballChamferStartOfBall
  const ballChamferRaw = Manifold.cylinder(
    ballChamferH,
    ballChamferWide,
    ballChamferNarrow,
    36,
    false,
  )
  const ballChamfer = ballChamferRaw.translate([0, 0, chamferZ0])
  deleteSafe(ballChamferRaw)

  // Thick stem from the ball chamfer all the way into the ball host
  const stemZ0 = chamferZ0 + ballChamferH * P.ballChamferOverlap
  const stemLen = Math.max(faceB + embed - stemZ0, ballR * P.midStemMinOfBall)
  const stemRaw = Manifold.cylinder(stemLen, stemR, -1, 28, false)
  const stem = stemRaw.translate([0, 0, stemZ0])
  deleteSafe(stemRaw)

  // Chamfered root at the BODY face — wide at the part, tapers to the stem
  const collarZ0 = Math.max(faceB - ballR * 0.6, centerZ + ballR * 1.05)
  const collarRaw = Manifold.cylinder(
    collarH,
    stemR * P.collarNarrowOfStem,
    stemR * P.collarWideOfStem,
    32,
    false,
  )
  const collar = collarRaw.translate([0, 0, collarZ0])
  deleteSafe(collarRaw)
  const stepRaw = Manifold.cylinder(
    stepH,
    stemR * P.stepNarrowOfStem,
    stemR * P.stepWideOfStem,
    28,
    false,
  )
  const step = stepRaw.translate([0, 0, collarZ0 + collarH * 0.12 - stepH * 0.35])
  deleteSafe(stepRaw)

  const united = Manifold.union([ball, ballChamfer, stem, collar, step])
  deleteSafe(ball)
  deleteSafe(ballChamfer)
  deleteSafe(stem)
  deleteSafe(collar)
  deleteSafe(step)
  return united
}

/** Socket cavity in the joint-local frame, concentric with createBallLocal. */
function createSocketCavityLocal(
  Manifold: ManifoldApi['Manifold'],
  dims: BallStemDims,
  filament: FilamentProfile,
  seat: JointSeat,
): ManifoldSolid {
  const { r, ballR, stemR, stemH } = dims
  // Radial fit = PLA test square (clearance 1.05 / mouth 0.955) — never drift here
  const { socketR, mouthR } = socketRadialDims(ballR, filament)
  const throatR = Math.max(stemR * 1.35, mouthR * 0.55)
  const { centerZ, faceB, faceS } = seat

  const socketRaw = Manifold.sphere(socketR, 40)
  const socket = socketRaw.translate([0, 0, centerZ])
  deleteSafe(socketRaw)

  // Mouth from the ball center out past the socket face (only ever subtracted
  // from the socket host, so overshooting into the kerf gap is harmless)
  const mouthTop = Math.max(faceB, 0) + Math.max(socketR * 0.4, r * 0.1)
  const mouthRaw = Manifold.cylinder(mouthTop - centerZ, mouthR, -1, 36, false)
  const mouth = mouthRaw.translate([0, 0, centerZ])
  deleteSafe(mouthRaw)

  // Funnel lead-in — same 1.22 flare as gen-pla-test-joint, wide end on the face
  const chamferH = Math.max(ballR * 0.4, r * 0.12)
  const leadRaw = Manifold.cylinder(chamferH, mouthR, mouthR * 1.22, 36, false)
  const lead = leadRaw.translate([0, 0, faceS - chamferH * 0.85])
  deleteSafe(leadRaw)

  // Extra stem play at the bottom of the cup
  const throatH = Math.max(stemH * 0.45, ballR * 0.25)
  const throatRaw = Manifold.cylinder(throatH, throatR, -1, 28, false)
  const throat = throatRaw.translate([0, 0, centerZ - throatH * 0.5])
  deleteSafe(throatRaw)

  let cavity = Manifold.union([socket, mouth, throat, lead])
  deleteSafe(socket)
  deleteSafe(mouth)
  deleteSafe(throat)
  deleteSafe(lead)

  // Flex slots (PLA): cut ONLY through the inner retaining lip — never out to the exterior skin
  if (filament.flexSlots > 0) {
    const lipInner = mouthR * 0.15
    const lipOuter = socketR * 1.12
    const slotLen = Math.max(lipOuter - lipInner, ballR * 0.25)
    const slotW = Math.max(ballR * 0.18, 1e-4)
    const slotH = socketR * 1.5
    const radialMid = (lipInner + lipOuter) * 0.5
    for (let i = 0; i < filament.flexSlots; i++) {
      const deg = (i / filament.flexSlots) * 360
      const raw = Manifold.cube([slotLen, slotW, slotH], true)
      const shifted = raw.translate([radialMid, 0, centerZ])
      deleteSafe(raw)
      const spun = shifted.rotate([0, 0, deg])
      deleteSafe(shifted)
      const next = Manifold.union([cavity, spun])
      deleteSafe(cavity)
      deleteSafe(spun)
      cavity = next
    }
  }

  return cavity
}

function createSocketCavity(
  Manifold: ManifoldApi['Manifold'],
  radius: number,
  joint: Joint,
  filament: FilamentProfile,
): ManifoldSolid {
  const dims = ballStemDims(radius, joint)
  return placeAlongAxis(
    createSocketCavityLocal(Manifold, dims, filament, defaultSeat(dims)),
    joint,
  )
}

/**
 * Preview / BVH fallback cutter: kerf + socket sphere (matches boolean intent).
 */
export function createJointCutter(
  Manifold: ManifoldApi['Manifold'],
  radius: number,
  joint: Joint,
  filamentType: FilamentType = DEFAULT_FILAMENT,
): ManifoldSolid {
  const kerf = createKerfDisk(Manifold, radius, joint)
  const socket = createSocketCavity(
    Manifold,
    radius,
    joint,
    getFilamentProfile(filamentType),
  )
  const united = Manifold.union([kerf, socket])
  deleteSafe(kerf)
  deleteSafe(socket)
  return united
}

function tryMakeManifold(
  Mesh: ManifoldApi['Mesh'],
  Manifold: ManifoldApi['Manifold'],
  geometry: THREE.BufferGeometry,
  modelSize: number,
): ManifoldSolid {
  const tolerances = [
    modelSize * 1e-6,
    modelSize * 1e-5,
    modelSize * 1e-4,
    modelSize * 1e-3,
    modelSize * 1e-2,
  ]

  let lastError: unknown
  for (const tol of tolerances) {
    try {
      const mesh = geometryToManifoldMesh(geometry, Mesh, Math.max(tol, 1e-12))
      const solid = new Manifold(mesh)
      if (solid.isEmpty()) {
        deleteSafe(solid)
        throw new Error('Empty manifold after import')
      }
      return solid
    } catch (err) {
      lastError = err
    }
  }

  const detail =
    lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')
  throw new Error(`NotManifold: ${detail}`)
}

function scaleGeometry(geometry: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const g = geometry.clone()
  g.scale(s, s, s)
  return g
}

function scaleJoints(joints: Joint[], s: number): Joint[] {
  return joints.map((j) => ({
    ...j,
    position: [j.position[0] * s, j.position[1] * s, j.position[2] * s],
  }))
}

function solidCentroid(solid: ManifoldSolid): THREE.Vector3 {
  const box = solid.boundingBox()
  return new THREE.Vector3(
    (box.min[0] + box.max[0]) * 0.5,
    (box.min[1] + box.max[1]) * 0.5,
    (box.min[2] + box.max[2]) * 0.5,
  )
}

function solidVolume(solid: ManifoldSolid): number {
  try {
    return Math.abs(solid.volume())
  } catch {
    const box = solid.boundingBox()
    return (
      Math.max(box.max[0] - box.min[0], 0) *
      Math.max(box.max[1] - box.min[1], 0) *
      Math.max(box.max[2] - box.min[2], 0)
    )
  }
}

/** Distance from joint to solid bbox (0 if joint is inside/on the piece). */
function distJointToSolid(solid: ManifoldSolid, joint: Joint): number {
  const box = solid.boundingBox()
  const [x, y, z] = joint.position
  const dx = Math.max(0, box.min[0] - x, x - box.max[0])
  const dy = Math.max(0, box.min[1] - y, y - box.max[1])
  const dz = Math.max(0, box.min[2] - z, z - box.max[2])
  return Math.hypot(dx, dy, dz)
}

function bboxesOverlap(a: ManifoldSolid, b: ManifoldSolid): boolean {
  const A = a.boundingBox()
  const B = b.boundingBox()
  for (let k = 0; k < 3; k++) {
    if (A.max[k] < B.min[k] || B.max[k] < A.min[k]) return false
  }
  return true
}

/** Inverse of placeAlongAxis: world → joint-local (cut plane z=0, +Z = cut normal). */
function toJointLocal(solid: ManifoldSolid, joint: Joint): ManifoldSolid {
  const inv = jointLocalToWorld(joint).invert()
  return solid.transform(inv.elements as unknown as Mat4)
}

function cropToBox(
  Manifold: ManifoldApi['Manifold'],
  solid: ManifoldSolid,
  x: [number, number],
  y: [number, number],
  z: [number, number],
): ManifoldSolid | null {
  const raw = Manifold.cube([x[1] - x[0], y[1] - y[0], z[1] - z[0]], false)
  const box = raw.translate([x[0], y[0], z[0]])
  deleteSafe(raw)
  let hit: ManifoldSolid
  try {
    hit = Manifold.intersection(solid, box)
  } catch {
    deleteSafe(box)
    return null
  }
  deleteSafe(box)
  if (hit.isEmpty() || solidVolume(hit) <= 1e-9) {
    deleteSafe(hit)
    return null
  }
  return hit
}

/** Distance from the cut plane to the nearest material in a column at (cx, cy). */
function nearFaceInColumn(
  Manifold: ManifoldApi['Manifold'],
  crop: ManifoldSolid,
  cx: number,
  cy: number,
  halfW: number,
  z: [number, number],
  side: 1 | -1,
): number | null {
  const col = cropToBox(Manifold, crop, [cx - halfW, cx + halfW], [cy - halfW, cy + halfW], z)
  if (!col) return null
  const b = col.boundingBox()
  deleteSafe(col)
  return Math.max(0, side > 0 ? b.min[2] : -b.max[2])
}

/**
 * Pick ONE spot on the cut plane where the ball host (+Z) and socket host (−Z)
 * both have material facing each other, then seat ball + socket there.
 * Ball and cavity share this seat, so the ball always lands inside its cup.
 */
function planJointSeat(
  Manifold: ManifoldApi['Manifold'],
  ballLocal: ManifoldSolid,
  sockLocal: ManifoldSolid,
  dims: BallStemDims,
  filament: FilamentProfile,
  jR: number,
): { cx: number; cy: number; seat: JointSeat } | null {
  const { ballR, stemR } = dims
  const { socketR } = socketRadialDims(ballR, filament)
  const L = jR * 1.4
  const reachB = jR * 1.2
  const reachS = jR * 1.4
  const cropB = cropToBox(Manifold, ballLocal, [-L, L], [-L, L], [0, reachB])
  const cropS = cropToBox(Manifold, sockLocal, [-L, L], [-L, L], [-reachS, 0])
  if (!cropB || !cropS) {
    deleteSafe(cropB)
    deleteSafe(cropS)
    return null
  }

  const bb = cropB.boundingBox()
  const sb = cropS.boundingBox()
  const x0 = Math.max(bb.min[0], sb.min[0])
  const x1 = Math.min(bb.max[0], sb.max[0])
  const y0 = Math.max(bb.min[1], sb.min[1])
  const y1 = Math.min(bb.max[1], sb.max[1])
  const cands: [number, number][] = [[0, 0]]
  if (x0 <= x1 && y0 <= y1) {
    for (const fx of [0.5, 0.25, 0.75]) {
      for (const fy of [0.5, 0.25, 0.75]) {
        cands.push([x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy])
      }
    }
  }

  let best: { cx: number; cy: number; nb: number; ns: number; cost: number } | null = null
  for (const [cx, cy] of cands) {
    const nb = nearFaceInColumn(Manifold, cropB, cx, cy, stemR * 1.1, [0, reachB], 1)
    if (nb == null) continue
    const ns = nearFaceInColumn(Manifold, cropS, cx, cy, socketR * 1.05, [-reachS, 0], -1)
    if (ns == null) continue
    // Stay on the user's marker unless it truly has no material facing across the cut
    const cost = nb + ns + 0.4 * Math.hypot(cx, cy)
    if (!best || cost < best.cost) best = { cx, cy, nb, ns, cost }
  }
  deleteSafe(cropB)
  deleteSafe(cropS)
  if (!best) return null

  return {
    cx: best.cx,
    cy: best.cy,
    seat: {
      centerZ: -Math.max(dims.stemH, best.ns + ballR * 0.8),
      faceB: best.nb,
      faceS: -best.ns,
    },
  }
}

/** Material volume of each piece in the half-ball on the +normal / −normal side of the cut. */
function halfProbeTouch(
  Manifold: ManifoldApi['Manifold'],
  pieces: ManifoldSolid[],
  joint: Joint,
  R: number,
): { pos: number[]; neg: number[] } {
  const makeHalf = (sign: 1 | -1) => {
    const sphere = Manifold.sphere(R, 24)
    const raw = Manifold.cube([R * 2.2, R * 2.2, R * 1.1], false)
    const box = raw.translate([-R * 1.1, -R * 1.1, sign > 0 ? 0 : -R * 1.1])
    deleteSafe(raw)
    const half = Manifold.intersection(sphere, box)
    deleteSafe(sphere)
    deleteSafe(box)
    return placeAlongAxis(half, joint)
  }
  const probes = [makeHalf(1), makeHalf(-1)]
  const [pos, neg] = probes.map((probe) =>
    pieces.map((p) => {
      if (distJointToSolid(p, joint) > R) return 0
      try {
        const hit = Manifold.intersection(p, probe)
        const v = hit.isEmpty() ? 0 : solidVolume(hit)
        deleteSafe(hit)
        return v
      } catch {
        return 0
      }
    }),
  )
  for (const p of probes) deleteSafe(p)
  return { pos, neg }
}

/** Index of the piece with the most volume inside a sphere at the joint (−1 if none). */
function pieceWithMostMaterialAt(
  Manifold: ManifoldApi['Manifold'],
  pieces: ManifoldSolid[],
  joint: Joint,
  R: number,
): number {
  const probe = Manifold.sphere(R, 24).translate(joint.position)
  let best = -1
  let bestVol = 0
  pieces.forEach((p, i) => {
    if (distJointToSolid(p, joint) > R) return
    try {
      const hit = Manifold.intersection(p, probe)
      const v = hit.isEmpty() ? 0 : solidVolume(hit)
      deleteSafe(hit)
      if (v > bestVol) {
        bestVol = v
        best = i
      }
    } catch {
      /* skip */
    }
  })
  deleteSafe(probe)
  return best
}

/** Z-up figures centered on X=0: a Z cut near the midline is the neck/waist. */
function isNeckJoint(joint: Joint, modelSize: number): boolean {
  return joint.axis === 'z' && Math.abs(joint.position[0]) < modelSize * 0.08
}

/** True for elbow/ankle-style joints that sit distal of a same-axis shoulder/hip. */
function isDistalLimbJoint(joint: Joint, all: Joint[], modelSize: number): boolean {
  if (joint.axis === 'z') return false
  return all.some((other) => {
    if (other.id === joint.id || other.axis !== joint.axis) return false
    const sameSide =
      Math.sign(other.position[0] || 1e-9) === Math.sign(joint.position[0] || 1e-9)
    return sameSide && other.position[2] > joint.position[2] + modelSize * 0.05
  })
}

/**
 * After kerfs sever limbs: for every joint pick the piece on each side of the
 * cut (local half-ball probes), then seat ball + socket at one shared spot.
 *   Neck (Z):  socket in the HEAD (upper), ball on the torso — frees torso
 *              volume for the shoulder cups.
 *   Elbow:     socket on the distal (lower) piece, ball on the proximal one
 *              (any off-center Z joint, or an X/Y joint below a same-side shoulder).
 *   Shoulder:  socket on the larger piece (torso), ball on the limb.
 */
function applyBallAndSocket(
  Manifold: ManifoldApi['Manifold'],
  pieces: ManifoldSolid[],
  joints: Joint[],
  baseRadius: number,
  modelSize: number,
  filament: FilamentProfile,
  warnings: string[],
  seats?: JointSeatRecord[],
): ManifoldSolid[] {
  const result = pieces.slice()
  const warn = (msg: string) => {
    console.warn(msg)
    warnings.push(msg)
  }

  for (const joint of joints) {
    const jR = jointWorldRadius(baseRadius, joint)
    const R = Math.max(jR * 1.25, modelSize * 0.03)
    const { pos, neg } = halfProbeTouch(Manifold, result, joint, R)
    const minTouch = Math.max(jR ** 3 * 0.01, 1e-6)
    const rank = (arr: number[]) =>
      arr
        .map((v, i) => ({ i, v }))
        .filter((e) => e.v >= minTouch)
        .sort((a, b) => b.v - a.v)
        .slice(0, 3)
    let pair: { p: number; n: number; score: number } | null = null
    for (const p of rank(pos)) {
      for (const n of rank(neg)) {
        if (p.i === n.i) continue
        const score = Math.min(p.v, n.v)
        if (!pair || score > pair.score) pair = { p: p.i, n: n.i, score }
      }
    }
    if (!pair) {
      warn(
        `Joint #${joint.id}: the cut didn't separate two parts here — no ball/socket. Move the marker onto the limb connection or check its Cut Axis.`,
      )
      continue
    }

    const cP = solidCentroid(result[pair.p])
    const cN = solidCentroid(result[pair.n])
    let socketIdx: number
    if (isNeckJoint(joint, modelSize)) {
      socketIdx = cP.z >= cN.z ? pair.p : pair.n
    } else if (joint.axis === 'z' || isDistalLimbJoint(joint, joints, modelSize)) {
      socketIdx = cP.z <= cN.z ? pair.p : pair.n
    } else {
      socketIdx = solidVolume(result[pair.p]) >= solidVolume(result[pair.n]) ? pair.p : pair.n
    }
    const ballIdx = socketIdx === pair.p ? pair.n : pair.p
    const ballSide: 1 | -1 = ballIdx === pair.p ? 1 : -1

    const localize = (s: ManifoldSolid) => {
      const l = toJointLocal(s, joint)
      if (ballSide > 0) return l
      const m = l.mirror([0, 0, 1])
      deleteSafe(l)
      return m
    }
    const toWorld = (s: ManifoldSolid, cx: number, cy: number) => {
      let w = s.translate([cx, cy, 0])
      deleteSafe(s)
      if (ballSide < 0) {
        const m = w.mirror([0, 0, 1])
        deleteSafe(w)
        w = m
      }
      return placeAlongAxis(w, joint)
    }

    const dims = ballStemDims(baseRadius, joint)
    const ballD = dims.ballR * 2
    if (ballD < MIN_RELIABLE_BALL_DIAMETER_MM) {
      const pct = Math.ceil((MIN_RELIABLE_BALL_DIAMETER_MM / ballD) * 100)
      warn(
        `Joint #${joint.id}: ball is only Ø${ballD.toFixed(1)} mm — fragile. Print this part with the stem lying flat, or scale the whole model to ${pct}% for a Ø${MIN_RELIABLE_BALL_DIAMETER_MM} mm ball.`,
      )
    }
    const ballLocal = localize(result[ballIdx])
    const sockLocal = localize(result[socketIdx])
    const plan = planJointSeat(Manifold, ballLocal, sockLocal, dims, filament, jR)
    deleteSafe(ballLocal)
    deleteSafe(sockLocal)
    if (!plan) {
      warn(`Joint #${joint.id}: the two parts don't face each other across the cut — no ball/socket.`)
      continue
    }
    console.log(
      `  Joint #${joint.id}: socket=part${socketIdx} ball=part${ballIdx} axis=${joint.axis} seat=(${plan.cx.toFixed(2)},${plan.cy.toFixed(2)}) gap=${plan.seat.faceB.toFixed(2)}/${(-plan.seat.faceS).toFixed(2)} center=${plan.seat.centerZ.toFixed(2)}`,
    )

    const cavity = toWorld(
      createSocketCavityLocal(Manifold, dims, filament, plan.seat),
      plan.cx,
      plan.cy,
    )
    const ball = toWorld(createBallLocal(Manifold, dims, plan.seat), plan.cx, plan.cy)

    let carved: ManifoldSolid | null = null
    let clipped: ManifoldSolid | null = null
    try {
      const before = solidVolume(result[socketIdx])
      carved = Manifold.difference(result[socketIdx], cavity)
      if (carved.isEmpty() || solidVolume(carved) < before * 0.15) {
        warn(`Joint #${joint.id}: the socket part is too small for this ball — no ball/socket.`)
        continue
      }
      // Ball must never fuse into the socket host — or any neighbor it grazes
      const blockers = [
        carved,
        ...result.filter((p, i) => i !== ballIdx && i !== socketIdx && bboxesOverlap(p, ball)),
      ]
      const wall = blockers.length > 1 ? Manifold.union(blockers) : carved
      clipped = Manifold.difference(ball, wall)
      if (wall !== carved) deleteSafe(wall)
      const united = Manifold.union([result[ballIdx], clipped])
      deleteSafe(result[socketIdx])
      deleteSafe(result[ballIdx])
      result[socketIdx] = carved
      result[ballIdx] = united
      carved = null
      if (seats) {
        const dot = toWorld(
          Manifold.sphere(1e-3, 4).translate([0, 0, plan.seat.centerZ]),
          plan.cx,
          plan.cy,
        )
        const c = solidCentroid(dot)
        deleteSafe(dot)
        seats.push({
          jointId: joint.id,
          center: [c.x, c.y, c.z],
          ballR: dims.ballR,
          socketR: socketRadialDims(dims.ballR, filament).socketR,
        })
      }
    } catch (err) {
      console.warn(err)
      warn(`Joint #${joint.id}: ball/socket boolean failed — no ball/socket.`)
    } finally {
      deleteSafe(carved)
      deleteSafe(clipped)
      deleteSafe(cavity)
      deleteSafe(ball)
    }
  }

  return result
}

/** Where each ball/socket pair was seated (debug / proofs). */
export type JointSeatRecord = {
  jointId: number
  center: [number, number, number]
  ballR: number
  socketR: number
}

type ArticDebug = { __ARTIC_DEBUG?: boolean; __ARTIC_SEATS?: JointSeatRecord[] }

export type CutResult = {
  cut: THREE.BufferGeometry
  parts: THREE.BufferGeometry[]
  /** Joints that were skipped or degraded — show these to the user. */
  warnings: string[]
}

export interface CutProgress {
  current: number
  total: number
  label: string
}

async function cutManifoldNormalized(
  sourceGeometry: THREE.BufferGeometry,
  joints: Joint[],
  baseRadius: number,
  onProgress?: (p: CutProgress) => void,
  filamentType: FilamentType = DEFAULT_FILAMENT,
): Promise<CutResult> {
  const filament = getFilamentProfile(filamentType)
  const warnings: string[] = []
  const wasm = await getManifold()
  const { Manifold, Mesh } = wasm

  sourceGeometry.computeBoundingBox()
  const box = sourceGeometry.boundingBox!
  const extent = box.max.clone().sub(box.min)
  const modelSize = Math.max(extent.x, extent.y, extent.z, 1e-9)

  const TARGET = 100
  const toNorm = TARGET / modelSize
  const fromNorm = modelSize / TARGET
  const normSize = TARGET

  const scaledGeo = scaleGeometry(sourceGeometry, toNorm)
  const scaledJoints = scaleJoints(joints, toNorm)
  const scaledRadius = baseRadius * toNorm

  onProgress?.({ current: 0, total: joints.length, label: 'Preparing mesh (Manifold)…' })
  await new Promise((r) => setTimeout(r, 0))

  let solid = tryMakeManifold(Mesh, Manifold, scaledGeo, TARGET)
  scaledGeo.dispose()

  // Dense scan STLs: Meshopt can't weld unique-vert soups — Manifold.simplify can.
  // Keep epsilon SMALL — large eps blends thin necks/armpits and kerfs stop severing.
  try {
    const rawTri = (solid as ManifoldSolid & { numTri: number | (() => number) }).numTri
    const triCount = typeof rawTri === 'function' ? Number(rawTri.call(solid)) : Number(rawTri)
    if (Number.isFinite(triCount) && triCount > 120_000) {
      onProgress?.({
        current: 0,
        total: joints.length,
        label: `Simplifying solid (${triCount} tris)…`,
      })
      await new Promise((r) => setTimeout(r, 0))
      const eps = Math.max(normSize * 0.0008, 0.04)
      const simplified = solid.simplify(eps)
      const rawAfter = (simplified as ManifoldSolid & { numTri: number | (() => number) }).numTri
      const after =
        typeof rawAfter === 'function' ? Number(rawAfter.call(simplified)) : Number(rawAfter)
      onProgress?.({
        current: 0,
        total: joints.length,
        label: `Simplified solid → ${Number.isFinite(after) ? after : '?'} tris…`,
      })
      deleteSafe(solid)
      solid = simplified
    }
  } catch (err) {
    console.warn('Manifold simplify skipped:', err)
  }

  // Distal X/Y joints (elbows): cut later so shoulder kerfs can free the limb
  // without a simultaneous elbow disk deleting the upper-arm band.
  const primaryJoints = scaledJoints
    .map((j, i) => ({ j, i }))
    .filter(({ j }) => !isDistalLimbJoint(j, scaledJoints, normSize))
  const distalJoints = scaledJoints
    .map((j, i) => ({ j, i }))
    .filter(({ j }) => isDistalLimbJoint(j, scaledJoints, normSize))

  // 1a) Primary kerfs: neck, shoulders, hips, …
  for (let step = 0; step < primaryJoints.length; step++) {
    const { j: joint, i: origI } = primaryJoints[step]
    onProgress?.({
      current: step + 1,
      total: joints.length,
      label: `Severing joint #${joints[origI].id}…`,
    })
    await new Promise((r) => setTimeout(r, 0))

    const kerf = createKerfDisk(Manifold, scaledRadius, joint, {
      mode: 'primary',
      neck: isNeckJoint(joint, normSize),
    })
    let next: ManifoldSolid
    try {
      next = Manifold.difference(solid, kerf)
    } catch (err) {
      deleteSafe(kerf)
      deleteSafe(solid)
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`Boolean cut failed on joint #${joints[origI].id}: ${detail}`)
    }
    deleteSafe(kerf)
    deleteSafe(solid)
    solid = next

    if (solid.isEmpty()) {
      deleteSafe(solid)
      throw new Error(
        `Joint #${joints[origI].id} removed the entire model. Use a smaller scale.`,
      )
    }
  }

  onProgress?.({
    current: primaryJoints.length,
    total: joints.length,
    label: 'Finding separate body parts…',
  })
  await new Promise((r) => setTimeout(r, 0))

  // 2) Connected components only — NEVER whole-model plane splits (that caused wafers)
  let pieces = solid.decompose()
  deleteSafe(solid)

  // Drop tiny debris
  const minVol = normSize ** 3 * 1e-6
  pieces = pieces.filter((p) => {
    const keep = !p.isEmpty() && solidVolume(p) >= minVol
    if (!keep) deleteSafe(p)
    return keep
  })
  console.log(
    `  After primary kerfs: ${pieces.length} pieces (${pieces.map((p) => solidVolume(p).toFixed(0)).join(',')})`,
  )

  // 1b) Distal kerfs on the arm/leg piece that contains each joint
  for (let step = 0; step < distalJoints.length; step++) {
    const { j: joint, i: origI } = distalJoints[step]
    onProgress?.({
      current: primaryJoints.length + step + 1,
      total: joints.length,
      label: `Severing joint #${joints[origI].id}…`,
    })
    await new Promise((r) => setTimeout(r, 0))

    // Cut whichever solid actually has material at the marker — never assume the
    // biggest piece is the torso (big-headed figures made that the head).
    const jR = jointWorldRadius(scaledRadius, joint)
    const hostIdx = pieceWithMostMaterialAt(Manifold, pieces, joint, jR * 0.8)
    if (hostIdx < 0) {
      warnings.push(`Joint #${joints[origI].id}: no part found at this marker — not cut.`)
      continue
    }

    const hostVol = solidVolume(pieces[hostIdx])
    const kerf = createKerfDisk(Manifold, scaledRadius, joint, {
      mode: 'distal',
      host: pieces[hostIdx],
    })
    let cutHost: ManifoldSolid
    try {
      cutHost = Manifold.difference(pieces[hostIdx], kerf)
    } catch (err) {
      deleteSafe(kerf)
      console.warn(err)
      warnings.push(`Joint #${joints[origI].id}: elbow cut failed — limb left uncut.`)
      continue
    }
    deleteSafe(kerf)

    if (cutHost.isEmpty() || solidVolume(cutHost) < hostVol * 0.2) {
      deleteSafe(cutHost)
      warnings.push(
        `Joint #${joints[origI].id}: elbow cut would delete most of the limb — limb left uncut. Try a smaller marker or move it.`,
      )
      continue
    }
    deleteSafe(pieces[hostIdx])

    let split: ManifoldSolid[]
    try {
      split = cutHost.decompose()
      deleteSafe(cutHost)
    } catch {
      split = [cutHost]
    }

    const kept = split.filter((p) => {
      const keep = !p.isEmpty() && solidVolume(p) >= minVol
      if (!keep) deleteSafe(p)
      return keep
    })
    console.log(
      `  Distal #${joints[origI].id}: hostVol=${hostVol.toFixed(0)} → ${kept.length} pieces (${kept.map((p) => solidVolume(p).toFixed(0)).join(',')})`,
    )
    pieces.splice(hostIdx, 1, ...kept)
  }

  if ((globalThis as ArticDebug).__ARTIC_DEBUG) {
    for (const [i, p] of pieces.entries()) {
      const b = p.boundingBox()
      const c = solidCentroid(p)
      console.log(
        `  piece ${i} vol=${solidVolume(p).toFixed(0)} c=(${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}) x[${b.min[0].toFixed(1)},${b.max[0].toFixed(1)}] z[${b.min[2].toFixed(1)},${b.max[2].toFixed(1)}]`,
      )
    }
    for (const j of scaledJoints) {
      console.log(
        `  joint ${j.id} ${j.axis} p=(${j.position.map((n) => n.toFixed(1)).join(',')}) jR=${jointWorldRadius(scaledRadius, j).toFixed(2)}`,
      )
    }
  }

  onProgress?.({
    current: joints.length,
    total: joints.length,
    label: 'Adding ball & socket to each joint…',
  })
  await new Promise((r) => setTimeout(r, 0))

  // 3) Ball on one side of each joint, socket cavity on the other
  if (pieces.length >= 2) {
    const dbg = globalThis as ArticDebug
    const seats: JointSeatRecord[] | undefined = dbg.__ARTIC_DEBUG ? [] : undefined
    pieces = applyBallAndSocket(
      Manifold,
      pieces,
      scaledJoints,
      scaledRadius,
      normSize,
      filament,
      warnings,
      seats,
    )
    if (seats) {
      dbg.__ARTIC_SEATS = seats.map((s) => ({
        jointId: s.jointId,
        center: [s.center[0] * fromNorm, s.center[1] * fromNorm, s.center[2] * fromNorm],
        ballR: s.ballR * fromNorm,
        socketR: s.socketR * fromNorm,
      }))
    }
  }

  const parts: THREE.BufferGeometry[] = []
  for (const p of pieces) {
    if (p.isEmpty()) {
      deleteSafe(p)
      continue
    }
    const g = manifoldToGeometry(p)
    g.scale(fromNorm, fromNorm, fromNorm)
    parts.push(g)
    deleteSafe(p)
  }

  parts.sort((a, b) => {
    const ac = (a.getAttribute('position') as THREE.BufferAttribute).count
    const bc = (b.getAttribute('position') as THREE.BufferAttribute).count
    return bc - ac
  })

  let cutGeo: THREE.BufferGeometry
  if (parts.length === 0) {
    cutGeo = sourceGeometry.clone()
  } else if (parts.length === 1) {
    cutGeo = parts[0].clone()
  } else {
    cutGeo =
      mergeGeometries(
        parts.map((p) => p.clone()),
        false,
      ) ?? parts[0].clone()
  }

  return { cut: cutGeo, parts: parts.length ? parts : [cutGeo.clone()], warnings }
}

export async function cutWithManifold(
  sourceGeometry: THREE.BufferGeometry,
  joints: Joint[],
  baseRadius: number,
  onProgress?: (p: CutProgress) => void,
  filamentType: FilamentType = DEFAULT_FILAMENT,
): Promise<CutResult> {
  try {
    return await cutManifoldNormalized(
      sourceGeometry,
      joints,
      baseRadius,
      onProgress,
      filamentType,
    )
  } catch (manifoldErr) {
    console.warn('Manifold cut failed, trying BVH fallback…', manifoldErr)
    onProgress?.({
      current: 0,
      total: joints.length,
      label: 'Manifold failed — trying fallback cutter…',
    })

    try {
      const cut = await cutWithBvhCsg(sourceGeometry, joints, baseRadius, onProgress)
      const parts = splitConnectedComponents(cut)
      return {
        cut,
        parts,
        warnings: [
          'Manifold could not read this mesh, so the fallback cutter was used: parts are split but have NO ball/socket joints. Repair the mesh (Simplify, or Blender → Make Manifold) and preview again.',
        ],
      }
    } catch (fallbackErr) {
      const a =
        manifoldErr instanceof Error ? manifoldErr.message : String(manifoldErr)
      const b =
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
      throw new Error(
        `Cut failed.\nManifold: ${a}\nFallback: ${b}\n\nIf the model isn’t watertight, repair it in Blender (3D-Print Toolbox → Make Manifold) and re-upload.`,
      )
    }
  }
}
