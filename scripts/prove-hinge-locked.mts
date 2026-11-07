/**
 * The snap-disc hinge (v3) passed its PLA print test on 2026-11-07 (stud printed
 * upright, arm end down) — it must not change. Checks against
 * scripts/baselines/hinge-locked.json:
 *   - the fit numbers (peg, hole clearance, lip, preload, split)
 *   - the test pair's stud and eye, built by the shared geometry code
 *   - the printed test pair files, and that the code still builds them
 *   - the engine's hinge cut on a round limb
 *
 *   npx tsx scripts/prove-hinge-locked.mts           # compare
 *   npx tsx scripts/prove-hinge-locked.mts --write   # re-record (only after a
 *                                                    # new hinge print test!)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'manifold-3d'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { buildEye, buildStud } from '../src/lib/hingeGeometry.ts'
import { HINGE_TEST, hingeTestSpec } from '../src/lib/hingeProfile.ts'
import type { Joint } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(__dirname, 'baselines/hinge-locked.json')

type Locked = {
  fit: Record<string, unknown>
  /** Stud, eye as built (volume + bounds, hinge-local frame). */
  pair: number[][]
  /** Stud, eye as printed (volume + bounds of the STL files). */
  files: number[][]
  cut: number[][]
  warnings: string[]
}

const r4 = (ns: number[]) => ns.map((n) => +n.toFixed(4))

function volume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position') as THREE.BufferAttribute
  const idx = g.getIndex()
  const n = idx ? idx.count : p.count
  const at = (i: number) => new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(i) : i)
  let v = 0
  for (let i = 0; i < n; i += 3) v += at(i).dot(at(i + 1).cross(at(i + 2))) / 6
  return Math.abs(v)
}
const fp = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox()
  const b = g.boundingBox!
  return r4([volume(g), b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z])
}

const wasm = await Module()
wasm.setup()
const { Manifold } = wasm

const H = hingeTestSpec()
const reach = H.discRadius + HINGE_TEST.armLength
const pair = [buildStud(Manifold, H, reach), buildEye(Manifold, H, reach)].map((s) => {
  const b = s.boundingBox()
  const out = r4([s.volume(), ...b.min, ...b.max])
  s.delete()
  return out
})

const files = ['stud', 'eye'].map((p) => {
  const buf = fs.readFileSync(path.join(__dirname, `../public/test-joints/hinge-${p}-${HINGE_TEST.version}.stl`))
  return fp(new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)))
})

// Ø8 mm round limb with a hinge at its middle.
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
const joint: Joint = { id: 1, position: [0, 0, 0], axis: 'z', scale: 1.3, rotation: 0, tilt: [0, 0, 0], kind: 'hinge' }
const log = console.log
console.log = () => {}
const { parts, cut: merged, warnings } = await cutAndSplitModel(limbs, [joint], 3, undefined, 'pla')
console.log = log
const cut = parts.map(fp).sort((a, b) => a[3] - b[3])
merged.dispose()
for (const g of parts) g.dispose()

const now: Locked = { fit: { ...HINGE_TEST }, pair, files, cut, warnings }

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
  ok('test pair as built (stud, eye)', close(now.pair, want.pair), now.pair.map((p) => p[0]).join(' / ') + ' mm³')
  ok('test pair files (stud, eye)', close(now.files, want.files), now.files.map((p) => p[0]).join(' / ') + ' mm³')
  ok(
    'code builds the printed pair',
    now.pair.every((p, i) => Math.abs(p[0] - now.files[i][0]) < 0.05),
    `${now.pair.map((p) => p[0]).join(' / ')} vs ${now.files.map((p) => p[0]).join(' / ')} mm³`,
  )
  ok('model cut on a round limb', close(now.cut, want.cut) && now.warnings.length === want.warnings.length, now.cut.map((p) => p[0]).join(' / ') + ' mm³')
  if (fails === 0) console.log('\nHINGE LOCKED OK — identical to the print-tested snap-disc hinge')
  else {
    console.log(`\nHINGE LOCKED FAILED (${fails}) — something changed the tested hinge`)
    process.exitCode = 1
  }
}
