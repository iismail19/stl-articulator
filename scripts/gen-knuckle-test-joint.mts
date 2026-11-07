/**
 * Knuckle print test: fork (cone bumps) + tongue (cone dimples). No separate pin.
 * Geometry comes from src/lib/knuckleGeometry.ts — the same code the model cut uses.
 *
 *   npx tsx scripts/gen-knuckle-test-joint.mts
 *       → knuckle-{fork,tongue}-v1.stl (the standard Ø9 mm pair)
 *   npx tsx scripts/gen-knuckle-test-joint.mts --robot <model.stl> --name dag4
 *       → also knuckle-dag4-{elbow,knee}-{fork,tongue}-v1.stl, sized exactly as
 *         the app builds that model's Auto-Suggest elbows and knees
 *
 * Print both lying on their side (bend axis vertical).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'manifold-3d'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { suggestFigureJoints } from '../src/lib/figureTemplate.ts'
import { buildFork, buildTongue } from '../src/lib/knuckleGeometry.ts'
import {
  KNUCKLE_TEST,
  knuckleLayout,
  knuckleTestSpec,
  type KnuckleSpec,
} from '../src/lib/knuckleProfile.ts'
import { hintToJoint, prepareProbeMesh, refitJointsToLimbs } from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '../public/test-joints')

type ManifoldApi = Awaited<ReturnType<typeof Module>>
type Solid = ReturnType<ManifoldApi['Manifold']['sphere']>

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

/** Bend axis (+Y) → up, then sit on the bed. */
function layFlat(solid: Solid): Solid {
  const up = solid.rotate([90, 0, 0])
  const minZ = up.boundingBox().min[2]
  const out = up.translate([0, 0, -minZ])
  up.delete()
  return out
}

/** Build, check through ±90°, and write `${prefix}-{fork,tongue}-v1.stl`. */
function writePair(Manifold: ManifoldApi['Manifold'], K: KnuckleSpec, armLength: number, prefix: string) {
  const L = knuckleLayout(K)
  console.log(`\n${prefix} (mm):`, {
    barrelDiameter: +(K.radius * 2).toFixed(2),
    width: +K.width.toFixed(2),
    cheek: +K.cheek.toFixed(2),
    tongue: +L.tongue.toFixed(2),
    bump: `Ø${(K.bumpRadius * 2).toFixed(2)} × ${K.bumpHeight.toFixed(2)}`,
    sideGap: K.sideGap,
    preload: K.preload,
  })
  const armReach = K.radius + armLength
  const fork = buildFork(Manifold, K, armReach)
  const tongue = buildTongue(Manifold, K, armReach)
  console.log('fork genus', fork.genus(), 'tongue genus', tongue.genus())

  // Assembled and swung through ±90° (the bridge joining the cheeks stops it
  // past that): only the bump pinch may overlap, and it must be there.
  const pinchMax = 2 * Math.PI * K.bumpRadius ** 2 * K.preload
  for (const deg of [0, 45, 90, -45, -90]) {
    const swung = tongue.rotate([0, deg, 0])
    const hit = Manifold.intersection(fork, swung)
    const v = hit.isEmpty() ? 0 : hit.volume()
    hit.delete()
    swung.delete()
    const ok = v > 1e-4 && v <= pinchMax + 0.01
    console.log(`${ok ? 'OK  ' : 'FAIL'} bend ${deg}° overlap ${v.toFixed(4)} mm³ (bump pinch ≤ ${pinchMax.toFixed(4)})`)
    if (!ok) throw new Error(`${prefix}: fork and tongue ${v <= 1e-4 ? 'have no pinch' : 'collide'} at ${deg}°`)
  }

  fs.mkdirSync(outDir, { recursive: true })
  const old = new RegExp(`^${prefix}-(fork|tongue)-v\\d+\\.stl$`)
  for (const f of fs.readdirSync(outDir)) {
    if (old.test(f)) fs.rmSync(path.join(outDir, f))
  }
  for (const [solid, name] of [
    [fork, 'fork'],
    [tongue, 'tongue'],
  ] as const) {
    const flat = layFlat(solid)
    solid.delete()
    const geo = solidToGeo(flat)
    flat.delete()
    writeStl(geo, path.join(outDir, `${prefix}-${name}-${KNUCKLE_TEST.version}.stl`))
    geo.dispose()
  }
}

/** The knuckle spec the app builds at each Auto-Suggest elbow / knee, smallest per name. */
async function robotSpecs(file: string): Promise<Map<string, KnuckleSpec>> {
  const buf = fs.readFileSync(file)
  const geo = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  geo.computeVertexNormals()
  geo.center()
  geo.computeBoundingBox()
  const size = geo.boundingBox!.getSize(new THREE.Vector3())
  const modelSize = Math.max(size.x, size.y, size.z)
  const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
  const probe = prepareProbeMesh(geo)
  const hints = suggestFigureJoints(probe, modelSize)
  const joints = refitJointsToLimbs(
    probe,
    hints.map((h, i) => hintToJoint(h, i + 1, baseRadius, h.kind)),
    baseRadius,
    modelSize,
  )
  const dbg = globalThis as { __ARTIC_DEBUG?: boolean; __ARTIC_KNUCKLES?: { jointId: number; spec: KnuckleSpec }[] }
  dbg.__ARTIC_DEBUG = true
  dbg.__ARTIC_KNUCKLES = []
  const log = console.log
  console.log = () => {}
  const { parts, cut, warnings } = await cutAndSplitModel(geo, joints, baseRadius, undefined, 'pla')
  console.log = log
  cut.dispose()
  for (const p of parts) p.dispose()
  if (warnings.length) console.log('cut warnings:', warnings)

  const out = new Map<string, KnuckleSpec>()
  for (const { jointId, spec } of dbg.__ARTIC_KNUCKLES) {
    const name = hints[jointId - 1].name
    const prev = out.get(name)
    if (!prev || spec.radius < prev.radius) out.set(name, { ...spec, swing: undefined })
  }
  return out
}

async function main() {
  const wasm = await Module()
  wasm.setup()
  const { Manifold } = wasm
  writePair(Manifold, knuckleTestSpec(), KNUCKLE_TEST.armLength, 'knuckle')

  const args = process.argv.slice(2)
  const robot = args[args.indexOf('--robot') + 1]
  if (args.includes('--robot') && robot) {
    const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'robot'
    const specs = await robotSpecs(robot)
    if (specs.size === 0) throw new Error('No knuckle joints were built on that model')
    const std = knuckleTestSpec()
    const close = (a: number, b: number) => Math.abs(a - b) <= b * 0.05
    for (const [part, K] of specs) {
      const prefix = `knuckle-${name}-${part}`
      for (const f of fs.readdirSync(outDir)) {
        if (new RegExp(`^${prefix}-(fork|tongue)-v\\d+\\.stl$`).test(f)) fs.rmSync(path.join(outDir, f))
      }
      if (close(K.radius, std.radius) && close(K.width, std.width)) {
        console.log(`\n${prefix}: within 5% of the standard pair — print that one instead, skipped`)
        continue
      }
      writePair(Manifold, K, Math.max(K.radius * 2.5, 8), prefix)
    }
  }
  console.log('\nDone →', outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
