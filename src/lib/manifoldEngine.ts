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
import { figureAxes, jointLocalToWorld, type FigureAxes } from './cutterGeometry'
import {
  DEFAULT_FILAMENT,
  getFilamentProfile,
  MIN_RELIABLE_BALL_DIAMETER_MM,
  socketRadialDims,
  type FilamentProfile,
  type FilamentType,
} from './filamentProfiles'
import { buildEye, buildStud, eyeBore, hingeCores, motionRecesses } from './hingeGeometry'
import {
  fitHingeToLimb,
  hingeDimsForJoint,
  MIN_RELIABLE_PEG_DIAMETER_MM,
  type HingeSpec,
} from './hingeProfile'
import { hostFigure, isDistalLimbJoint, isNeckJoint, type SocketSide } from './hostSide'
import { getJointKind, normalizeJointKind } from './jointKinds'
import {
  buildForkBody,
  buildTongueBody,
  forkBumps,
  knuckleCores,
  knuckleRecesses,
  tongueDimples,
} from './knuckleGeometry'
import {
  fitKnuckleToLimb,
  knuckleDimsForJoint,
  knuckleLayout,
  MIN_RELIABLE_TONGUE_MM,
  scaleKnuckleSpec,
  type KnuckleSpec,
} from './knuckleProfile'
import { splitConnectedComponents } from './splitMesh'
import { buildBoreBody, buildPostBody, swivelBore, swivelCores } from './swivelGeometry'
import {
  MIN_RELIABLE_POST_DIAMETER_MM,
  scaleSwivelSpec,
  swivelDimsForRoom,
  type SwivelSpec,
} from './swivelProfile'

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

function scaleHingeSpec(H: HingeSpec, k: number): HingeSpec {
  return {
    discRadius: H.discRadius * k,
    studThickness: H.studThickness * k,
    eyeThickness: H.eyeThickness * k,
    pegDiameter: H.pegDiameter * k,
    holeClearance: H.holeClearance * k,
    lipMm: H.lipMm * k,
    lipLength: H.lipLength * k,
    shoulderPreload: H.shoulderPreload * k,
    splitWidth: H.splitWidth * k,
    motionClearance: H.motionClearance * k,
    embed: H.embed * k,
  }
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

export function tryMakeManifold(
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

/** Pair of piece indices facing across a joint cut, or null. */
function findJointPair(
  Manifold: ManifoldApi['Manifold'],
  pieces: ManifoldSolid[],
  joint: Joint,
  jR: number,
  modelSize: number,
): { p: number; n: number } | null {
  const R = Math.max(jR * 1.25, modelSize * 0.03)
  const { pos, neg } = halfProbeTouch(Manifold, pieces, joint, R)
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
  return pair ? { p: pair.p, n: pair.n } : null
}

/** Which piece gets the socket/fork (vs ball/tang), same anatomy rules as before. */
function pickHostRoles(
  pieces: ManifoldSolid[],
  pair: { p: number; n: number },
  joint: Joint,
  joints: Joint[],
  modelSize: number,
  figure: FigureAxes,
): { primaryIdx: number; secondaryIdx: number; primaryOnPos: boolean } {
  const cP = solidCentroid(pieces[pair.p])[figure.up]
  const cN = solidCentroid(pieces[pair.n])[figure.up]
  let primaryIdx: number
  if (isNeckJoint(joint, modelSize, figure)) {
    primaryIdx = cP >= cN ? pair.p : pair.n
  } else if (joint.axis === figure.up || isDistalLimbJoint(joint, joints, modelSize, figure)) {
    primaryIdx = cP <= cN ? pair.p : pair.n
  } else {
    primaryIdx = solidVolume(pieces[pair.p]) >= solidVolume(pieces[pair.n]) ? pair.p : pair.n
  }
  if (joint.swapSides) primaryIdx = primaryIdx === pair.p ? pair.n : pair.p
  const secondaryIdx = primaryIdx === pair.p ? pair.n : pair.p
  return {
    primaryIdx,
    secondaryIdx,
    primaryOnPos: primaryIdx === pair.p,
  }
}


/**
 * After kerfs sever limbs: for every joint pick the piece on each side of the
 * cut, then seat ball/socket or hinge hardware.
 *   Neck (up): socket/fork in the HEAD (upper), ball/tang on the torso.
 *   Elbow:     socket/fork on the distal piece, ball/tang on the proximal one.
 *   Shoulder:  socket/fork on the larger piece (torso), ball/tang on the limb.
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
  notes?: string[],
  mmToNorm = 1,
  socketSides?: Record<number, SocketSide>,
  figure: FigureAxes = { up: 'z', depth: 'y' },
): ManifoldSolid[] {
  const result = pieces.slice()
  const warn = (msg: string) => {
    console.warn(msg)
    warnings.push(msg)
  }
  const note = (msg: string) => {
    notes?.push(msg)
  }
  // Advice, not failure: the hardware was built, it's just on the small side.
  const caution = (msg: string) => {
    console.warn(msg)
    notes?.push(`Heads up — ${msg}`)
  }

  for (const joint of joints) {
    const kind = normalizeJointKind(joint.kind)
    if (kind === 'universal') {
      warn(
        `Joint #${joint.id}: ${getJointKind(kind).label} is not built yet — only the cut ran. Use Ball, Hinge or Knuckle for working hardware.`,
      )
      continue
    }

    const jR = jointWorldRadius(baseRadius, joint)
    const pair = findJointPair(Manifold, result, joint, jR, modelSize)
    if (!pair) {
      warn(
        `Joint #${joint.id}: the cut didn't separate two parts here — no ${kind} hardware. Move the marker onto the limb connection or check its Cut Axis.`,
      )
      continue
    }

    const roles = pickHostRoles(result, pair, joint, joints, modelSize, hostFigure(kind, figure))
    if (socketSides) socketSides[joint.id] = roles.primaryOnPos ? 1 : -1
    // When the primary host sits on +Z, flip so socket/fork convention is −Z.
    const flip = roles.primaryOnPos
    const localize = (s: ManifoldSolid) => {
      const l = toJointLocal(s, joint)
      if (!flip) return l
      const m = l.mirror([0, 0, 1])
      deleteSafe(l)
      return m
    }
    const toWorld = (s: ManifoldSolid, cx: number, cy: number) => {
      let w = s.translate([cx, cy, 0])
      deleteSafe(s)
      if (flip) {
        const m = w.mirror([0, 0, 1])
        deleteSafe(w)
        w = m
      }
      return placeAlongAxis(w, joint)
    }

    if (kind === 'knuckle') {
      const owned: ManifoldSolid[] = []
      const keep = (s: ManifoldSolid) => {
        owned.push(s)
        return s
      }
      try {
        // Fork on the primary (−Z in local after flip), tongue on the secondary (+Z).
        const forkIdx = roles.primaryIdx
        const tongueIdx = roles.secondaryIdx
        const rawFork = keep(localize(result[forkIdx]))
        const rawTongue = keep(localize(result[tongueIdx]))

        const reach = jR * 2.2
        const depth = jR * 0.9
        const rawForkChunk = keep(
          Manifold.intersection(
            rawFork,
            keep(Manifold.cube([reach * 2, reach * 2, depth], false).translate([-reach, -reach, -depth])),
          ),
        )
        const rawTongueChunk = keep(
          Manifold.intersection(
            rawTongue,
            keep(Manifold.cube([reach * 2, reach * 2, depth], false).translate([-reach, -reach, 0])),
          ),
        )
        if (rawForkChunk.isEmpty() || rawTongueChunk.isEmpty()) {
          warn(`Joint #${joint.id}: no limb on one side of the knuckle — no knuckle hardware. Move the marker onto the limb.`)
          continue
        }
        // Center the knuckle on the material both limbs share at the cut, not on
        // the marker point — a marker a little off-center would leave no width.
        const fb = rawForkChunk.boundingBox()
        const tb = rawTongueChunk.boundingBox()
        const mid = (i: number) =>
          (Math.max(fb.min[i], tb.min[i]) + Math.min(fb.max[i], tb.max[i])) / 2
        const cx = mid(0)
        const cy = mid(1)
        const centered = (s: ManifoldSolid) => keep(s.translate([-cx, -cy, 0]))
        const forkLocal = centered(rawFork)
        const tongueLocal = centered(rawTongue)
        const forkChunk = centered(rawForkChunk)
        const tongueChunk = centered(rawTongueChunk)
        const room = (m: ManifoldSolid) => {
          const b = m.boundingBox()
          return {
            x: Math.min(-b.min[0], b.max[0]),
            y: Math.min(-b.min[1], b.max[1]),
            xOut: Math.max(-b.min[0], b.max[0]),
          }
        }
        const rf = room(forkChunk)
        const rt = room(tongueChunk)
        const base = scaleKnuckleSpec(knuckleDimsForJoint(jR / mmToNorm), mmToNorm)
        const dimpleDepth = knuckleLayout(base).dimpleDepth
        const fitted = fitKnuckleToLimb(
          base,
          Math.min(rf.x, rt.x),
          Math.min(rf.y, rt.y),
          1.2 * mmToNorm,
          Math.max(MIN_RELIABLE_TONGUE_MM * 0.6 * mmToNorm, dimpleDepth * 2 + 0.6 * mmToNorm),
        )
        if (!fitted) {
          warn(`Joint #${joint.id}: limb is too thin here for a knuckle — use Ball, or scale the model up.`)
          continue
        }
        // Clear each limb out to its own widest point so the other can swing past
        // it — capped, because the probe box can catch a torso or hip beside the limb.
        const limbHalf = Math.min(Math.max(rf.xOut, rt.xOut), fitted.radius * 1.3)
        const K = { ...fitted, swing: limbHalf + fitted.motionClearance }
        const KL = knuckleLayout(K)
        const tongueMm = KL.tongue / mmToNorm
        if (tongueMm < MIN_RELIABLE_TONGUE_MM) {
          const pct = Math.ceil((MIN_RELIABLE_TONGUE_MM / tongueMm) * 100)
          caution(
            `Joint #${joint.id}: knuckle tongue is only ${tongueMm.toFixed(1)} mm thick — may be fragile. Scaling the whole model to ${pct}% gives ${MIN_RELIABLE_TONGUE_MM} mm.`,
          )
        }

        // Clip hardware to each limb's own outline so nothing pokes out of the surface.
        const armReach = K.radius + depth
        const cores = knuckleCores(Manifold, K)
        keep(cores.fork)
        keep(cores.tongue)
        const forkEnvelope = keep(Manifold.hull([forkChunk, cores.fork]))
        const tongueEnvelope = keep(Manifold.hull([tongueChunk, cores.tongue]))
        const forkHw = keep(
          Manifold.intersection(keep(buildForkBody(Manifold, K, armReach)), forkEnvelope),
        )
        const tongueHw = keep(
          Manifold.intersection(keep(buildTongueBody(Manifold, K, armReach)), tongueEnvelope),
        )
        const recess = knuckleRecesses(Manifold, K, reach)
        keep(recess.forkLimb)
        keep(recess.tongueLimb)

        // Slot after the union so limb material can't fill it; bumps/dimples last.
        const forkSlotted = keep(
          Manifold.difference(keep(Manifold.union([forkLocal, forkHw])), recess.forkLimb),
        )
        const forkFinal = Manifold.union([forkSlotted, keep(forkBumps(Manifold, K))])
        const tongueJoined = keep(
          Manifold.union([keep(Manifold.difference(tongueLocal, recess.tongueLimb)), tongueHw]),
        )
        const tongueFinal = Manifold.difference(tongueJoined, keep(tongueDimples(Manifold, K)))

        deleteSafe(result[forkIdx])
        deleteSafe(result[tongueIdx])
        result[forkIdx] = toWorld(forkFinal, cx, cy)
        result[tongueIdx] = toWorld(tongueFinal, cx, cy)
        note(
          `Joint #${joint.id} knuckle: slide the rounded tongue into the fork until the bumps click into its dimples. No separate pin, no glue.`,
        )
        const dbg = globalThis as ArticDebug
        if (dbg.__ARTIC_DEBUG) {
          ;(dbg.__ARTIC_KNUCKLES ??= []).push({ jointId: joint.id, spec: scaleKnuckleSpec(K, 1 / mmToNorm) })
        }
        console.log(
          `  Joint #${joint.id}: knuckle fork=part${forkIdx} tongue=part${tongueIdx} R=${(K.radius / mmToNorm).toFixed(2)}mm width=${(K.width / mmToNorm).toFixed(2)}mm tongue=${tongueMm.toFixed(2)}mm`,
        )
      } catch (err) {
        console.warn(err)
        warn(`Joint #${joint.id}: knuckle boolean failed — limb stays cut with no knuckle hardware.`)
      } finally {
        for (const s of owned) deleteSafe(s)
      }
      continue
    }

    if (kind === 'hinge') {
      const owned: ManifoldSolid[] = []
      const keep = (s: ManifoldSolid) => {
        owned.push(s)
        return s
      }
      try {
        // Eye on the primary (−Z in local after flip), stud on the secondary (+Z).
        const eyeIdx = roles.primaryIdx
        const studIdx = roles.secondaryIdx
        const eyeLocal = keep(localize(result[eyeIdx]))
        const studLocal = keep(localize(result[studIdx]))

        // Measure each limb just past the cut so the hinge fits inside it.
        const reach = jR * 2.2
        const depth = jR * 0.9
        const eyeChunk = keep(
          Manifold.intersection(
            eyeLocal,
            keep(Manifold.cube([reach * 2, reach * 2, depth], false).translate([-reach, -reach, -depth])),
          ),
        )
        const studChunk = keep(
          Manifold.intersection(
            studLocal,
            keep(Manifold.cube([reach * 2, reach * 2, depth], false).translate([-reach, -reach, 0])),
          ),
        )
        if (eyeChunk.isEmpty() || studChunk.isEmpty()) {
          warn(`Joint #${joint.id}: no limb on one side of the hinge — no hinge hardware. Move the marker onto the limb.`)
          continue
        }
        const room = (m: ManifoldSolid) => {
          const b = m.boundingBox()
          return {
            x: Math.min(-b.min[0], b.max[0]),
            y: Math.min(-b.min[1], b.max[1]),
          }
        }
        const re = room(eyeChunk)
        const rs = room(studChunk)
        // Fit numbers are real mm; this space is normalized, so size in mm then scale.
        const jRmm = jR / mmToNorm
        const H = fitHingeToLimb(
          scaleHingeSpec(hingeDimsForJoint(jRmm), mmToNorm),
          Math.min(re.x, rs.x),
          Math.min(re.y, rs.y),
          1.0 * mmToNorm,
        )
        if (!H || H.discRadius <= 0) {
          warn(`Joint #${joint.id}: limb is too thin here for a hinge — use Ball, or scale the model up.`)
          continue
        }
        const pegMm = H.pegDiameter / mmToNorm
        if (pegMm < MIN_RELIABLE_PEG_DIAMETER_MM) {
          const pct = Math.ceil((MIN_RELIABLE_PEG_DIAMETER_MM / pegMm) * 100)
          caution(
            `Joint #${joint.id}: hinge peg is only Ø${pegMm.toFixed(1)} mm — may be fragile. Scaling the whole model to ${pct}% gives a Ø${MIN_RELIABLE_PEG_DIAMETER_MM} mm peg.`,
          )
        }

        // Hardware is clipped to each limb's own outline (hull of the limb end + disc),
        // so arms fill the gap to the limb but never poke out of the surface.
        const armReach = H.discRadius + depth
        const cores = hingeCores(Manifold, H)
        keep(cores.stud)
        keep(cores.eye)
        const eyeEnvelope = keep(Manifold.hull([eyeChunk, cores.eye]))
        const studEnvelope = keep(Manifold.hull([studChunk, cores.stud]))
        const eyeHw = keep(Manifold.intersection(keep(buildEye(Manifold, H, armReach)), eyeEnvelope))
        const studHw = keep(
          Manifold.intersection(keep(buildStud(Manifold, H, armReach)), studEnvelope),
        )
        const recess = motionRecesses(Manifold, H, reach)
        keep(recess.eyeLimb)
        keep(recess.studLimb)
        const bore = keep(eyeBore(Manifold, H))

        const eyeJoined = keep(
          Manifold.union([keep(Manifold.difference(eyeLocal, recess.eyeLimb)), eyeHw]),
        )
        // Bore last so limb material can never plug the hole.
        const eyeFinal = Manifold.difference(eyeJoined, bore)
        const studFinal = Manifold.union([
          keep(Manifold.difference(studLocal, recess.studLimb)),
          studHw,
        ])

        deleteSafe(result[eyeIdx])
        deleteSafe(result[studIdx])
        result[eyeIdx] = toWorld(eyeFinal, 0, 0)
        result[studIdx] = toWorld(studFinal, 0, 0)
        note(
          `Joint #${joint.id} hinge: snap peg (Ø${pegMm.toFixed(1)} mm) is molded onto one part — press it through the other part's hole until it clicks. No separate pin, no glue.`,
        )
        console.log(
          `  Joint #${joint.id}: hinge eye=part${eyeIdx} stud=part${studIdx} discR=${(H.discRadius / mmToNorm).toFixed(2)}mm width=${((H.studThickness + H.eyeThickness) / mmToNorm).toFixed(2)}mm peg=${pegMm.toFixed(2)}mm`,
        )
      } catch (err) {
        console.warn(err)
        warn(`Joint #${joint.id}: hinge boolean failed — limb stays cut with no hinge hardware.`)
      } finally {
        for (const s of owned) deleteSafe(s)
      }
      continue
    }

    if (kind === 'swivel') {
      const owned: ManifoldSolid[] = []
      const keep = (s: ManifoldSolid) => {
        owned.push(s)
        return s
      }
      try {
        // Bore on the primary (−Z in local after flip), post on the secondary (+Z).
        const boreIdx = roles.primaryIdx
        const postIdx = roles.secondaryIdx
        const rawBore = keep(localize(result[boreIdx]))
        const rawPost = keep(localize(result[postIdx]))

        const reach = jR * 2.2
        const depth = jR * 0.9
        const rawBoreChunk = keep(
          Manifold.intersection(
            rawBore,
            keep(Manifold.cube([reach * 2, reach * 2, depth], false).translate([-reach, -reach, -depth])),
          ),
        )
        const rawPostChunk = keep(
          Manifold.intersection(
            rawPost,
            keep(Manifold.cube([reach * 2, reach * 2, depth], false).translate([-reach, -reach, 0])),
          ),
        )
        if (rawBoreChunk.isEmpty() || rawPostChunk.isEmpty()) {
          warn(`Joint #${joint.id}: no limb on one side of the swivel — no swivel hardware. Move the marker onto the limb.`)
          continue
        }
        // Turn about the middle of the material both limbs share at the cut.
        const bb = rawBoreChunk.boundingBox()
        const pb = rawPostChunk.boundingBox()
        const mid = (i: number) =>
          (Math.max(bb.min[i], pb.min[i]) + Math.min(bb.max[i], pb.max[i])) / 2
        const cx = mid(0)
        const cy = mid(1)
        const centered = (s: ManifoldSolid) => keep(s.translate([-cx, -cy, 0]))
        const boreLocal = centered(rawBore)
        const postLocal = centered(rawPost)
        const boreChunk = centered(rawBoreChunk)
        const postChunk = centered(rawPostChunk)
        const room = (m: ManifoldSolid) => {
          const b = m.boundingBox()
          return Math.min(-b.min[0], b.max[0], -b.min[1], b.max[1])
        }
        const roomMm = Math.min(room(boreChunk), room(postChunk)) / mmToNorm
        const fitted = roomMm > 0 ? swivelDimsForRoom(roomMm) : null
        if (!fitted) {
          warn(`Joint #${joint.id}: limb is too thin here for a swivel — use Ball, or scale the model up.`)
          continue
        }
        const postMm = fitted.postDiameter
        if (postMm < MIN_RELIABLE_POST_DIAMETER_MM) {
          const pct = Math.ceil((MIN_RELIABLE_POST_DIAMETER_MM / postMm) * 100)
          caution(
            `Joint #${joint.id}: swivel post is only Ø${postMm.toFixed(1)} mm — may be fragile. Scaling the whole model to ${pct}% gives a Ø${MIN_RELIABLE_POST_DIAMETER_MM} mm post.`,
          )
        }
        const S = scaleSwivelSpec(fitted, mmToNorm)

        // Hardware is clipped to each limb's own outline (hull of the limb end + collar),
        // so the collars fill the cut gap but never poke out of the surface.
        const cores = swivelCores(Manifold, S)
        keep(cores.post)
        keep(cores.bore)
        const postEnvelope = keep(Manifold.hull([postChunk, cores.post]))
        const boreEnvelope = keep(Manifold.hull([boreChunk, cores.bore]))
        const postHw = keep(Manifold.intersection(keep(buildPostBody(Manifold, S, depth)), postEnvelope))
        const boreHw = keep(Manifold.intersection(keep(buildBoreBody(Manifold, S, depth)), boreEnvelope))

        const postFinal = Manifold.union([postLocal, postHw])
        // Bore last so limb material can never plug the hole.
        const boreFinal = Manifold.difference(
          keep(Manifold.union([boreLocal, boreHw])),
          keep(swivelBore(Manifold, S)),
        )

        deleteSafe(result[boreIdx])
        deleteSafe(result[postIdx])
        result[boreIdx] = toWorld(boreFinal, cx, cy)
        result[postIdx] = toWorld(postFinal, cx, cy)
        note(
          `Joint #${joint.id} swivel: snap post (Ø${postMm.toFixed(1)} mm) is molded onto one part — push it into the other part's hole until it clicks. It turns all the way round. No separate pin, no glue.`,
        )
        const dbg = globalThis as ArticDebug
        if (dbg.__ARTIC_DEBUG) {
          ;(dbg.__ARTIC_SWIVELS ??= []).push({ jointId: joint.id, spec: fitted })
        }
        console.log(
          `  Joint #${joint.id}: swivel bore=part${boreIdx} post=part${postIdx} collarR=${fitted.collarRadius.toFixed(2)}mm post=${postMm.toFixed(2)}mm`,
        )
      } catch (err) {
        console.warn(err)
        warn(`Joint #${joint.id}: swivel boolean failed — limb stays cut with no swivel hardware.`)
      } finally {
        for (const s of owned) deleteSafe(s)
      }
      continue
    }

    // —— ball & socket ——
    const socketIdx = roles.primaryIdx
    const ballIdx = roles.secondaryIdx
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

type ArticDebug = {
  __ARTIC_DEBUG?: boolean
  __ARTIC_SEATS?: JointSeatRecord[]
  /** Knuckle specs as built, in mm (or print-at-100 mm units). */
  __ARTIC_KNUCKLES?: { jointId: number; spec: KnuckleSpec }[]
  /** Swivel specs as built, in mm (or print-at-100 mm units). */
  __ARTIC_SWIVELS?: { jointId: number; spec: SwivelSpec }[]
}

export type CutResult = {
  cut: THREE.BufferGeometry
  /** Body pieces (fork/tang or ball/socket already in the mesh). */
  parts: THREE.BufferGeometry[]
  /** Joints that were skipped or degraded — show these to the user. */
  warnings: string[]
  /** Non-error tips (assembly). Shown as info, never as a failure toast. */
  notes: string[]
  /** Per joint id: which side of the cut normal got the socket / hole / fork. */
  socketSides?: Record<number, SocketSide>
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
  const notes: string[] = []
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
    label: 'Adding joint hardware…',
  })
  await new Promise((r) => setTimeout(r, 0))

  // 3) Ball/socket or hinge hardware on each joint
  const socketSides: Record<number, SocketSide> = {}
  if (pieces.length >= 2) {
    const dbg = globalThis as ArticDebug
    const seats: JointSeatRecord[] | undefined = dbg.__ARTIC_DEBUG ? [] : undefined
    // Under 20 units tall can't be a real-mm figure (e.g. a 1-unit export), so
    // size mm fit numbers as if it prints at 100 mm — the same space the ball uses.
    const unitsAreMm = modelSize >= 20
    if (!unitsAreMm && joints.some((j) => ['hinge', 'knuckle'].includes(normalizeJointKind(j.kind)))) {
      notes.push(
        `This model is only ${modelSize.toPrecision(2)} units across, so it isn't in mm — hinge/knuckle fit assumes you print it ${TARGET} mm on its longest side.`,
      )
    }
    pieces = applyBallAndSocket(
      Manifold,
      pieces,
      scaledJoints,
      scaledRadius,
      normSize,
      filament,
      warnings,
      seats,
      notes,
      unitsAreMm ? toNorm : 1,
      socketSides,
      figureAxes([extent.x, extent.y, extent.z]),
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

  return {
    cut: cutGeo,
    parts: parts.length ? parts : [cutGeo.clone()],
    warnings,
    notes,
    socketSides,
  }
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
          'Manifold could not read this mesh, so the fallback cutter was used: parts are split but have NO joint hardware. Repair the mesh (Simplify, or Blender → Make Manifold) and preview again.',
        ],
        notes: [],
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
