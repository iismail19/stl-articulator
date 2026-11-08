/**
 * The snap-post swivel (v2) passed its PLA print test on 2026-11-07 (bore printed
 * hole-down) — it must not change. Checks against scripts/baselines/swivel-locked.json:
 *   - the fit numbers (post, hole clearance, lip, chamfer, preload, split)
 *   - the test pair's post and bore, built by the shared geometry code
 *   - the printed test pair files, and that the code still builds them
 *   - the engine's swivel cut on a round limb
 *
 *   npx tsx scripts/prove-swivel-locked.mts           # compare
 *   npx tsx scripts/prove-swivel-locked.mts --write   # re-record (only after a
 *                                                     # new swivel print test!)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'manifold-3d'
import type { Mat4 } from 'manifold-3d'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { buildBoreBody, buildPostBody, swivelBore } from '../src/lib/swivelGeometry.ts'
import { SWIVEL_TEST, swivelTestSpec } from '../src/lib/swivelProfile.ts'
import type { Joint } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(__dirname, 'baselines/swivel-locked.json')

type Locked = {
  fit: Record<string, unknown>
  /** Post, bore as built (volume + bounds, swivel-local frame). */
  pair: number[][]
  /** Post, bore after the print orientation (post shaved flat, bore hole-down). */
  printed: number[]
  /** Post, bore as printed (volume + bounds of the STL files). */
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

const S = swivelTestSpec()
const reach = SWIVEL_TEST.bodyLength
const post = buildPostBody(Manifold, S, reach)
const boreBody = buildBoreBody(Manifold, S, reach)
const cavity = swivelBore(Manifold, S)
const bore = Manifold.difference(boreBody, cavity)
boreBody.delete()
cavity.delete()
const pair = [post, bore].map((s) => {
  const b = s.boundingBox()
  return r4([s.volume(), ...b.min, ...b.max])
})
// Same print pose as gen-swivel-test-joint.mts: post on its side with a 0.6 mm
// flat shaved so it can't roll, bore flipped so the hole sits on the bed.
const turn = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1] as unknown as Mat4
const side = post.transform(turn)
post.delete()
const flat = 0.6
const keep = Manifold.cube([100, 100, 100], false).translate([-50, -50, -S.collarRadius + flat])
const shaved = Manifold.intersection(side, keep)
side.delete()
keep.delete()
const postFlat = shaved.translate([0, 0, S.collarRadius - flat])
shaved.delete()
const boreDown = bore.rotate([180, 0, 0])
bore.delete()
const printed = [postFlat, boreDown].map((s) => {
  const v = +s.volume().toFixed(4)
  s.delete()
  return v
})

const files = ['post', 'bore'].map((p) => {
  const buf = fs.readFileSync(path.join(__dirname, `../public/test-joints/swivel-${p}-${SWIVEL_TEST.version}.stl`))
  return fp(new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)))
})

// Ø8 mm round limb with a swivel at its middle.
const limb = new THREE.CylinderGeometry(4, 4, 41, 48)
limb.rotateX(Math.PI / 2)
const joint: Joint = { id: 1, position: [0, 0, 0], axis: 'z', scale: 1.3, rotation: 0, tilt: [0, 0, 0], kind: 'swivel' }
const log = console.log
console.log = () => {}
const { parts, cut: merged, warnings } = await cutAndSplitModel(limb, [joint], 3, undefined, 'pla')
console.log = log
const cut = parts.map(fp).sort((a, b) => a[3] - b[3])
merged.dispose()
for (const g of parts) g.dispose()

const now: Locked = { fit: { ...SWIVEL_TEST }, pair, printed, files, cut, warnings }

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
  ok('test pair as built (post, bore)', close(now.pair, want.pair), now.pair.map((p) => p[0]).join(' / ') + ' mm³')
  ok('test pair files (post, bore)', close(now.files, want.files), now.files.map((p) => p[0]).join(' / ') + ' mm³')
  ok(
    'print pose matches the printed files',
    now.printed.every((v, i) => Math.abs(v - now.files[i][0]) < 0.05),
    `${now.printed.join(' / ')} vs ${now.files.map((p) => p[0]).join(' / ')} mm³`,
  )
  ok('model cut on a round limb', close(now.cut, want.cut) && now.warnings.length === want.warnings.length, now.cut.map((p) => p[0]).join(' / ') + ' mm³')
  if (fails === 0) console.log('\nSWIVEL LOCKED OK — identical to the print-tested snap-post swivel')
  else {
    console.log(`\nSWIVEL LOCKED FAILED (${fails}) — something changed the tested swivel`)
    process.exitCode = 1
  }
}
