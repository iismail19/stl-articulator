/**
 * Tiny PLA snap-fit test pair (ball+stem + socket block).
 * Uses the same ballStemProfile + filamentProfiles as the app cuts.
 * Writes versioned STLs to public/test-joints/ (avoid browser cache).
 *
 *   npx tsx scripts/gen-pla-test-joint.mts
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
  getFilamentProfile,
  PLA_VALIDATED,
  socketRadialDims,
} from '../src/lib/filamentProfiles.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '../public/test-joints')
/** Bump when strength / snap geometry changes so browsers don't cache old STLs */
const VERSION = 'v10'

type ManifoldApi = Awaited<ReturnType<typeof Module>>
type Solid = ReturnType<ManifoldApi['Manifold']['sphere']>

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

async function main() {
  const wasm = await Module()
  wasm.setup()
  const { Manifold } = wasm
  const filament = getFilamentProfile('pla')
  const P = BALL_STEM

  // Ø8 mm ball — same proportions the app uses for a joint of world radius r
  const ballR = 4
  const r = ballR / P.ballOfR
  const dims = computeBallStemDims(r)
  const {
    stemR,
    stemH,
    embed,
    ballChamferH,
    ballChamferWide,
    ballChamferNarrow,
    collarH,
    stepH,
  } = dims
  const mid = midStemPlacement(dims)
  // Same clearance as app cuts (PLA_VALIDATED — do not floor or loosen)
  const { socketR, mouthR } = socketRadialDims(ballR, filament)
  const flexSlots = filament.flexSlots

  console.log('PLA test joint (mm) — matches app ballStemProfile + PLA_VALIDATED:', {
    version: VERSION,
    ballDiameter: ballR * 2,
    stemR: +stemR.toFixed(3),
    stemH: +stemH.toFixed(2),
    midStemLen: +mid.len.toFixed(2),
    ballChamferH: +ballChamferH.toFixed(2),
    socketClearance: filament.socketClearance,
    mouthR: +mouthR.toFixed(3),
    mouthRatio: +(mouthR / ballR).toFixed(3),
    flexSlots,
    locked: PLA_VALIDATED,
  })

  // ── Male: print base on bed, ball UP ──────────────────────────────
  // App local axis: ball at −Z, body at +Z. Flip for print: ball at +Z.
  const baseH = 5
  const base = Manifold.cube([24, 24, baseH], true).translate([0, 0, baseH / 2])

  // Map app mid-stem (z0 → z0+len toward body) onto print Z (up toward ball)
  // Print layout: base → collar/step → mid stem → ball chamfer → ball
  const ballZ = baseH + embed + stemH
  const ball = Manifold.sphere(ballR, 48).translate([0, 0, ballZ])

  // Chamfer under ball: wide against sphere, narrow toward stem (down)
  // App: cylinder(wide→narrow) from ballZ_app + start, growing +Z toward body
  // Print: cylinder(narrow→wide) under ball, growing +Z toward ball
  const bChZ0 = ballZ - ballR * P.ballChamferStartOfBall - ballChamferH
  const bCh = Manifold.cylinder(
    ballChamferH,
    ballChamferNarrow,
    ballChamferWide,
    40,
    false,
  ).translate([0, 0, bChZ0])

  // Mid stem: same length as app; sit it so cones nearly meet
  // App mid starts at chamferZ0 + chamferH*overlap (into the chamfer toward body)
  // Print: mid top should enter the ball chamfer the same amount
  const stemTop = bChZ0 + ballChamferH * (1 - P.ballChamferOverlap)
  const stemZ0 = stemTop - mid.len
  const stem = Manifold.cylinder(mid.len, stemR, -1, 36, false).translate([0, 0, stemZ0])

  // Body collar on the square — wide at base, tapers up to stem
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
  del(base)
  del(collar)
  del(step)
  del(stem)
  del(bCh)
  del(ball)

  // ── Female socket (same ratios as createSocketCavity) ─────────────
  const blockH = Math.max(stemH + socketR * 2.2, 18)
  const block = Manifold.cube([26, 26, blockH], true).translate([0, 0, blockH / 2])
  const seatZ = blockH - stemH
  const socket = Manifold.sphere(socketR, 40).translate([0, 0, seatZ])
  const wellBot = stemH + socketR * 0.25
  const wellTop = blockH - seatZ + socketR * 0.8
  const wellH = wellTop + wellBot
  const mouth = Manifold.cylinder(wellH, mouthR, -1, 40, false).translate([
    0,
    0,
    seatZ - wellBot,
  ])
  const throatH = Math.max(stemH * 0.45, ballR * 0.25)
  const throatR = Math.max(stemR * 1.35, mouthR * 0.55)
  const throat = Manifold.cylinder(throatH, throatR, -1, 28, false).translate([
    0,
    0,
    seatZ - throatH * 0.5,
  ])
  const chamferH = Math.max(ballR * 0.4, 2.0)
  const lead = Manifold.cylinder(chamferH, mouthR, mouthR * 1.22, 40, false).translate([
    0,
    0,
    blockH - chamferH + 0.35,
  ])
  let cavity = Manifold.union([socket, mouth, throat, lead])
  del(socket)
  del(mouth)
  del(throat)
  del(lead)

  if (flexSlots > 0) {
    const lipInner = mouthR * 0.15
    const lipOuter = socketR * 1.12
    const slotLen = Math.max(lipOuter - lipInner, ballR * 0.25)
    const slotW = Math.max(ballR * 0.18, 0.6)
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
  del(cavity)

  fs.mkdirSync(outDir, { recursive: true })

  const maleGeo = solidToGeo(male)
  const femaleGeo = solidToGeo(female)
  del(male)
  del(female)

  writeStl(maleGeo, path.join(outDir, `pla-ball-stem-${VERSION}.stl`))
  writeStl(femaleGeo, path.join(outDir, `pla-socket-${VERSION}.stl`))
  writeStl(maleGeo, path.join(outDir, 'pla-ball-stem.stl'))
  writeStl(femaleGeo, path.join(outDir, 'pla-socket.stl'))
  maleGeo.dispose()
  femaleGeo.dispose()

  console.log('Done →', outDir)
  console.log(`Download (${VERSION} — shared strength profile w/ app):`)
  console.log(`  http://127.0.0.1:5173/test-joints/pla-ball-stem-${VERSION}.stl`)
  console.log(`  http://127.0.0.1:5173/test-joints/pla-socket-${VERSION}.stl`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
