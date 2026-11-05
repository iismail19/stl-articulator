/**
 * Tiny PLA snap-fit test pairs (ball+stem + socket block).
 * Uses the same ballStemProfile + filamentProfiles as the app cuts.
 * Writes versioned STLs to public/test-joints/ (avoid browser cache).
 *
 *   npx tsx scripts/gen-pla-test-joint.mts            # validated PLA
 *   npx tsx scripts/gen-pla-test-joint.mts pla_plus  # any FilamentType id
 *
 * Two pairs per filament:
 *   - Reference: Ø8 ball, straight — the pair the PLA fit was validated on.
 *   - Small angled: Ø4 ball, joint face tilted like an elbow cut, printed
 *     upright the way a limb prints. Cavity lead-in / slots match the model cut.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'manifold-3d'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import {
  BALL_STEM,
  computeBallStemDims,
  midStemPlacement,
} from '../src/lib/ballStemProfile.ts'
import {
  FILAMENT_PROFILES,
  getFilamentProfile,
  socketRadialDims,
  type FilamentProfile,
} from '../src/lib/filamentProfiles.ts'
import type { FilamentType } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '../public/test-joints')
/** Bump when strength / snap geometry changes so browsers don't cache old STLs */
const VERSION = 'v12'
/** Solid plastic kept around the cavity / under the stem — just enough to print and flex like a limb */
const WALL = 1.6
const FLOOR = 1.2

type ManifoldApi = Awaited<ReturnType<typeof Module>>
type ManifoldClass = ManifoldApi['Manifold']
type Solid = ReturnType<ManifoldClass['sphere']>

interface PairSpec {
  /** File name part after the filament prefix, e.g. '' or '-d4-angled' */
  tag: string
  ballR: number
  /** Joint axis tilt from vertical, degrees (0 = straight) */
  tiltDeg: number
  /** Use the model cut's lead-in and slot widths instead of the reference pair's */
  matchModelCut: boolean
}

const PAIRS: PairSpec[] = [
  { tag: '', ballR: 4, tiltDeg: 0, matchModelCut: false },
  { tag: '-d4-angled', ballR: 2, tiltDeg: 22, matchModelCut: true },
]

function del(obj: { delete: () => void } | null | undefined) {
  try {
    obj?.delete()
  } catch {
    /* */
  }
}

function solidToGeo(solid: Solid): THREE.BufferGeometry {
  const mesh = solid.getMesh()
  const n = mesh.numProp
  const pos = new Float32Array(mesh.numVert * 3)
  for (let i = 0; i < mesh.numVert; i++) {
    pos[i * 3] = mesh.vertProperties[i * n]
    pos[i * 3 + 1] = mesh.vertProperties[i * n + 1]
    pos[i * 3 + 2] = mesh.vertProperties[i * n + 2]
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setIndex(Array.from(mesh.triVerts))
  geo.computeVertexNormals()
  return geo
}

function writeStl(geo: THREE.BufferGeometry, file: string) {
  const data = new STLExporter().parse(new THREE.Mesh(geo), { binary: true }) as DataView
  fs.writeFileSync(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  console.log('Wrote', file, `(${(fs.statSync(file).size / 1024).toFixed(1)} KB)`)
}

/** Tilt about Y, then slice flat at zCut and drop onto the bed. */
function tiltOntoBed(Manifold: ManifoldClass, solid: Solid, tiltDeg: number, zCut: number): Solid {
  const tilted = solid.rotate([0, tiltDeg, 0])
  const big = 1000
  const keep = Manifold.cube([big, big, big], true).translate([0, 0, zCut + big / 2])
  const cut = tilted.intersect(keep)
  del(tilted)
  del(keep)
  const out = cut.translate([0, 0, -zCut])
  del(cut)
  return out
}

function buildPair(Manifold: ManifoldClass, filament: FilamentProfile, spec: PairSpec) {
  const P = BALL_STEM
  const { ballR, tiltDeg, matchModelCut } = spec
  const tilted = tiltDeg !== 0
  const t = (tiltDeg * Math.PI) / 180

  const r = ballR / P.ballOfR
  const dims = computeBallStemDims(r)
  const { stemR, stemH, embed, ballChamferH, ballChamferWide, ballChamferNarrow, collarH, stepH } =
    dims
  const mid = midStemPlacement(dims)
  const { socketR, mouthR } = socketRadialDims(ballR, filament)
  const flexSlots = filament.flexSlots

  console.log(`${filament.label} Ø${ballR * 2}${tilted ? ` tilted ${tiltDeg}°` : ''} (mm):`, {
    stemR: +stemR.toFixed(3),
    stemH: +stemH.toFixed(2),
    gap: +(socketR - ballR).toFixed(3),
    lip: +(ballR - mouthR).toFixed(3),
    flexSlots,
  })

  // ── Male: base on bed, ball UP ─────────────────────────────────────
  // Tilted: the base becomes a post that is sliced flat after tilting, so the
  // joint face (post top) sits at tiltDeg like an angled limb cut.
  const baseH = 2.5
  const baseW = Math.max(tilted ? 8 : 12, stemR * P.collarWideOfStem * 2 + 2 * WALL)
  const postDrop = tilted ? baseW * Math.tan(t) + 3 : 0
  const base = Manifold.cube([baseW, baseW, baseH + postDrop], true).translate([
    0,
    0,
    (baseH - postDrop) / 2,
  ])

  const ballZ = baseH + embed + stemH
  const ball = Manifold.sphere(ballR, 48).translate([0, 0, ballZ])
  const bChZ0 = ballZ - ballR * P.ballChamferStartOfBall - ballChamferH
  const bCh = Manifold.cylinder(ballChamferH, ballChamferNarrow, ballChamferWide, 40, false).translate(
    [0, 0, bChZ0],
  )
  const stemTop = bChZ0 + ballChamferH * (1 - P.ballChamferOverlap)
  const stemZ0 = stemTop - mid.len
  const stem = Manifold.cylinder(mid.len, stemR, -1, 36, false).translate([0, 0, stemZ0])
  const collar = Manifold.cylinder(
    collarH,
    stemR * P.collarWideOfStem,
    stemR * P.collarNarrowOfStem,
    36,
    false,
  ).translate([0, 0, baseH - 0.5])
  const step = Manifold.cylinder(
    stepH,
    stemR * P.stepWideOfStem,
    stemR * P.stepNarrowOfStem,
    32,
    false,
  ).translate([0, 0, baseH + collarH * 0.45])

  let male = Manifold.union([base, collar, step, stem, bCh, ball])
  for (const s of [base, collar, step, stem, bCh, ball]) del(s)

  // ── Female socket ─────────────────────────────────────────────────
  // Mouth runs only from the ball center up to the face (like the model cut) —
  // no bore below the seat, so the ball bottoms out exactly where it belongs.
  const seatZ = socketR + FLOOR
  const blockH = seatZ + stemH
  const blockW = 2 * (socketR * 1.12 + WALL)
  const blockDrop = tilted ? blockW * Math.tan(t) + 3 : 0
  const block = Manifold.cube([blockW, blockW, blockH + blockDrop], true).translate([
    0,
    0,
    (blockH - blockDrop) / 2,
  ])
  const socket = Manifold.sphere(socketR, 40).translate([0, 0, seatZ])
  const mouthH = stemH + socketR * 0.8
  const mouth = Manifold.cylinder(mouthH, mouthR, -1, 40, false).translate([0, 0, seatZ])
  const throatH = Math.max(stemH * 0.45, ballR * 0.25)
  const throatR = Math.max(stemR * 1.35, mouthR * 0.55)
  const throat = Manifold.cylinder(throatH, throatR, -1, 28, false).translate([
    0,
    0,
    seatZ - throatH * 0.5,
  ])
  const chamferH = matchModelCut ? Math.max(ballR * 0.4, r * 0.12) : Math.max(ballR * 0.4, 2.0)
  const lead = Manifold.cylinder(chamferH, mouthR, mouthR * 1.22, 40, false).translate([
    0,
    0,
    blockH - chamferH + 0.35,
  ])
  let cavity = Manifold.union([socket, mouth, throat, lead])
  for (const s of [socket, mouth, throat, lead]) del(s)

  if (flexSlots > 0) {
    const lipInner = mouthR * 0.15
    const lipOuter = socketR * 1.12
    const slotLen = Math.max(lipOuter - lipInner, ballR * 0.25)
    const slotW = matchModelCut ? Math.max(ballR * 0.18, 1e-4) : Math.max(ballR * 0.18, 0.6)
    const slotH = socketR * 1.5
    const radialMid = (lipInner + lipOuter) * 0.5
    for (let i = 0; i < flexSlots; i++) {
      const deg = (i / flexSlots) * 360
      const raw = Manifold.cube([slotLen, slotW, slotH], true)
      const shifted = raw.translate([radialMid, 0, seatZ])
      del(raw)
      const spun = shifted.rotate([0, 0, deg])
      del(shifted)
      const next = Manifold.union([cavity, spun])
      del(cavity)
      del(spun)
      cavity = next
    }
  }

  let female = Manifold.difference(block, cavity)
  del(block)

  if (tilted) {
    // Slice under the lowest tilted top-face corner (male) / under the cavity (female)
    const maleCut = baseH * Math.cos(t) - (baseW / 2) * Math.sin(t) - 1
    const tiltedCavity = cavity.rotate([0, tiltDeg, 0])
    const femaleCut = tiltedCavity.boundingBox().min[2] - FLOOR
    del(tiltedCavity)
    const m = tiltOntoBed(Manifold, male, tiltDeg, maleCut)
    del(male)
    male = m
    const f = tiltOntoBed(Manifold, female, tiltDeg, femaleCut)
    del(female)
    female = f
  }
  del(cavity)

  const size = (s: Solid) => {
    const b = s.boundingBox()
    return [0, 1, 2].map((i) => (b.max[i] - b.min[i]).toFixed(1)).join(' × ')
  }
  console.log('  Print sizes (mm):', { ballPiece: size(male), socketBlock: size(female) })
  return { male, female }
}

async function main() {
  const wasm = await Module()
  wasm.setup()
  const { Manifold } = wasm
  const filamentId = (process.argv[2] ?? 'pla') as FilamentType
  if (!Object.hasOwn(FILAMENT_PROFILES, filamentId)) {
    throw new Error(`Unknown filament "${filamentId}" — use one of: ${Object.keys(FILAMENT_PROFILES).join(', ')}`)
  }
  const filament = getFilamentProfile(filamentId)
  const prefix = filamentId.replace('_', '-')
  fs.mkdirSync(outDir, { recursive: true })

  for (const spec of PAIRS) {
    const { male, female } = buildPair(Manifold, filament, spec)
    const maleGeo = solidToGeo(male)
    const femaleGeo = solidToGeo(female)
    del(male)
    del(female)
    const name = `${prefix}${spec.tag}`
    writeStl(maleGeo, path.join(outDir, `${name}-ball-stem-${VERSION}.stl`))
    writeStl(femaleGeo, path.join(outDir, `${name}-socket-${VERSION}.stl`))
    if (!spec.tag) {
      writeStl(maleGeo, path.join(outDir, `${name}-ball-stem.stl`))
      writeStl(femaleGeo, path.join(outDir, `${name}-socket.stl`))
    }
    maleGeo.dispose()
    femaleGeo.dispose()
  }
  console.log('Done →', outDir)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
