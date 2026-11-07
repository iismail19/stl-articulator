/**
 * The knuckle (v1) passed its print tests on 2026-11-07, at the standard size and
 * at the thin Dag 4″ knee size — it must not change. Checks against
 * scripts/baselines/knuckle-locked.json:
 *   - the fit numbers (side gap, bump, preload, cheek, size)
 *   - the standard test pair's fork and tongue, built by the shared geometry code
 *   - the engine's knuckle cut on a standard-size round limb
 *   - the printed thin pair files
 *   - the full Auto-Suggest cut of Dag_natural_happy_4inch.stl (ball + knuckle), and
 *     that the app's thinnest knee still builds the same pair that was printed
 *
 *   npx tsx scripts/prove-knuckle-locked.mts           # compare
 *   npx tsx scripts/prove-knuckle-locked.mts --write   # re-record (only after a
 *                                                      # new knuckle print test!)
 *
 * Tuning for thinner knuckles must leave all of this identical.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'manifold-3d'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { buildFork, buildTongue } from '../src/lib/knuckleGeometry.ts'
import { KNUCKLE_TEST, knuckleTestSpec, type KnuckleSpec } from '../src/lib/knuckleProfile.ts'
import { suggestFigureJoints } from '../src/lib/figureTemplate.ts'
import { hintToJoint, prepareProbeMesh, refitJointsToLimbs } from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { Joint } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(__dirname, 'baselines/knuckle-locked.json')

type Locked = {
  fit: Record<string, unknown>
  pair: number[][]
  cut: number[][]
  warnings: string[]
  /** Printed thin pair files (fork, tongue). */
  thinPair: number[][]
  /** Dag 4″ Auto-Suggest cut — skipped when the model isn't on this machine. */
  dag?: {
    parts: number[][]
    knuckles: { joint: string; spec: number[] }[]
    warnings: string[]
    thinPairFromApp: number[]
  }
}

const r4 = (ns: number[]) => ns.map((n) => +n.toFixed(4))

const wasm = await Module()
wasm.setup()
const { Manifold } = wasm

const K = knuckleTestSpec()
const reach = K.radius + KNUCKLE_TEST.armLength
const pair = [buildFork(Manifold, K, reach), buildTongue(Manifold, K, reach)].map((s) => {
  const b = s.boundingBox()
  const out = r4([s.volume(), ...b.min, ...b.max])
  s.delete()
  return out
})

function volume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position') as THREE.BufferAttribute
  const idx = g.getIndex()
  const n = idx ? idx.count : p.count
  const at = (i: number) => new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(i) : i)
  let v = 0
  for (let i = 0; i < n; i += 3) v += at(i).dot(at(i + 1).cross(at(i + 2))) / 6
  return Math.abs(v)
}

// Ø8 mm round limb — gives a knuckle at the standard test size.
const limbs = mergeGeometries(
  [10.5, -10.5].map((z) => {
    const c = new THREE.CylinderGeometry(4, 4, 20, 40)
    c.rotateX(Math.PI / 2)
    c.translate(0, 0, z)
    return c.toNonIndexed()
  }).concat([(() => {
    const c = new THREE.CylinderGeometry(4, 4, 1.2, 40)
    c.rotateX(Math.PI / 2)
    return c.toNonIndexed()
  })()]),
  false,
)!
const joint: Joint = { id: 1, position: [0, 0, 0], axis: 'z', scale: 1.3, rotation: 0, tilt: [0, 0, 0], kind: 'knuckle' }
const log = console.log
console.log = () => {}
const { parts, cut: merged, warnings } = await cutAndSplitModel(limbs, [joint], 3, undefined, 'pla')
console.log = log
const cut = parts
  .map((g) => {
    g.computeBoundingBox()
    const b = g.boundingBox!
    return r4([volume(g), b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z])
  })
  .sort((a, b) => a[3] - b[3])
merged.dispose()
for (const g of parts) g.dispose()

// —— Thin knuckle (Dag 4″ knee size), print-tested 2026-11-07 ——
const fp = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox()
  const b = g.boundingBox!
  return r4([volume(g), b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z])
}
const loadStl = (file: string) => {
  const buf = fs.readFileSync(file)
  return new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}
const thinFiles = ['fork', 'tongue'].map((p) => path.join(__dirname, `../public/test-joints/knuckle-dag4-knee-${p}-${KNUCKLE_TEST.version}.stl`))
const thinPair = thinFiles.map((f) => fp(loadStl(f)))

// The user's robot: every Auto-Suggest joint, ball and knuckle, exactly as the app cuts it.
const DAG4 = '/Users/wind/Downloads/Dag_natural_happy_4inch.stl'
let dag: Locked['dag']
if (fs.existsSync(DAG4)) {
  const geo = loadStl(DAG4)
  geo.computeVertexNormals()
  geo.center()
  geo.computeBoundingBox()
  const s = geo.boundingBox!.getSize(new THREE.Vector3())
  const modelSize = Math.max(s.x, s.y, s.z)
  const baseRadius = suggestBaseRadius([s.x, s.y, s.z])
  const probe = prepareProbeMesh(geo)
  const hints = suggestFigureJoints(probe, modelSize)
  const joints = refitJointsToLimbs(probe, hints.map((h, i) => hintToJoint(h, i + 1, baseRadius, h.kind)), baseRadius, modelSize)
  const dbg = globalThis as { __ARTIC_DEBUG?: boolean; __ARTIC_KNUCKLES?: { jointId: number; spec: KnuckleSpec }[] }
  dbg.__ARTIC_DEBUG = true
  dbg.__ARTIC_KNUCKLES = []
  console.log = () => {}
  const res = await cutAndSplitModel(geo, joints, baseRadius, undefined, 'pla')
  console.log = log
  dbg.__ARTIC_DEBUG = false
  const knees = dbg.__ARTIC_KNUCKLES.filter((k) => hints[k.jointId - 1].name === 'knee')
  const thinnest = knees.sort((a, b) => a.spec.radius - b.spec.radius)[0].spec
  const K2 = { ...thinnest, swing: undefined }
  const pairNow = [buildFork, buildTongue].map((build) => {
    const m = build(Manifold, K2, K2.radius + Math.max(K2.radius * 2.5, 8))
    const v = +m.volume().toFixed(2)
    m.delete()
    return v
  })
  dag = {
    parts: res.parts.map(fp).sort((a, b) => a[0] - b[0]),
    knuckles: dbg.__ARTIC_KNUCKLES.map((k) => ({
      joint: `${hints[k.jointId - 1].name} #${k.jointId}`,
      spec: r4([k.spec.radius, k.spec.width, k.spec.cheek, k.spec.bumpRadius, k.spec.bumpHeight, k.spec.sideGap, k.spec.preload]),
    })),
    warnings: res.warnings,
    thinPairFromApp: pairNow,
  }
  res.cut.dispose()
  for (const g of res.parts) g.dispose()
}

const now: Locked = { fit: { ...KNUCKLE_TEST }, pair, cut, warnings, thinPair, dag }

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n')
  console.log('Wrote', BASELINE)
} else {
  const want = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Locked
  const close = (a: number[][], b: number[][]) =>
    a.length === b.length && a.every((p, i) => p.length === b[i].length && p.every((v, k) => Math.abs(v - b[i][k]) <= 1e-3 + Math.abs(b[i][k]) * 1e-6))
  let fails = 0
  const ok = (name: string, pass: boolean, detail: string) => {
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${name} — ${detail}`)
    if (!pass) fails++
  }
  ok('fit numbers', JSON.stringify(now.fit) === JSON.stringify(want.fit), JSON.stringify(now.fit))
  ok('standard test pair (fork, tongue)', close(now.pair, want.pair), now.pair.map((p) => p[0]).join(' / ') + ' mm³')
  ok('model cut at standard size', close(now.cut, want.cut) && now.warnings.length === want.warnings.length, now.cut.map((p) => p[0]).join(' / ') + ' mm³')
  ok('thin test pair files (fork, tongue)', close(now.thinPair, want.thinPair), now.thinPair.map((p) => p[0]).join(' / ') + ' mm³')
  if (now.dag && want.dag) {
    ok(
      'Dag 4″ knuckle sizes',
      JSON.stringify(now.dag.knuckles) === JSON.stringify(want.dag.knuckles),
      now.dag.knuckles.map((k) => `${k.joint} R${k.spec[0]}`).join(', '),
    )
    ok('Dag 4″ full Auto-Suggest cut', close(now.dag.parts, want.dag.parts) && now.dag.warnings.length === 0, `${now.dag.parts.length} parts, no warnings`)
    ok(
      'app’s thinnest Dag knee = the printed thin pair',
      now.dag.thinPairFromApp.every((v, i) => Math.abs(v - now.thinPair[i][0]) < 0.05),
      `${now.dag.thinPairFromApp.join(' / ')} vs ${now.thinPair.map((p) => p[0]).join(' / ')} mm³`,
    )
  } else console.log('skip Dag 4″ checks — model not found')
  if (fails === 0) console.log('\nKNUCKLE LOCKED OK — identical to the print-tested knuckles (standard and thin)')
  else {
    console.log(`\nKNUCKLE LOCKED FAILED (${fails}) — something changed the tested knuckle`)
    process.exitCode = 1
  }
}
