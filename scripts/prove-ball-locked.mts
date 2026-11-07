/**
 * The print-tested ball joint must come out of the engine exactly as it did
 * when it was locked. Cuts a fixed set of ball joints and compares every part's
 * volume and bounds against scripts/baselines/ball-locked.json, recorded from
 * commit 1560f57 (the ball-only engine, before hinge / knuckle existed).
 *
 *   npx tsx scripts/prove-ball-locked.mts           # compare
 *   npx tsx scripts/prove-ball-locked.mts --write   # record a new baseline (only
 *                                                   # after a new ball print test!)
 *
 * Self-contained on purpose (only booleanCut + three), so the same file runs
 * against old commits to record their output.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(__dirname, 'baselines/ball-locked.json')
const DAG4 = '/Users/wind/Downloads/Dag_natural_happy_4inch.stl'

type Axis = 'x' | 'y' | 'z'
type BallJoint = { id: number; position: [number, number, number]; axis: Axis; scale: number; rotation: number; tilt: [number, number, number] }
type Fingerprint = { parts: number; pieces: number[][]; warnings: string[] }

function rod(r: number, len: number, along: Axis, at: [number, number, number]) {
  const c = new THREE.CylinderGeometry(r, r, len, 40)
  if (along === 'z') c.rotateX(Math.PI / 2)
  if (along === 'x') c.rotateZ(Math.PI / 2)
  c.translate(...at)
  return c.toNonIndexed()
}

function volume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position') as THREE.BufferAttribute
  const idx = g.getIndex()
  const n = idx ? idx.count : p.count
  const at = (i: number) => new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(i) : i)
  let v = 0
  for (let i = 0; i < n; i += 3) v += at(i).dot(at(i + 1).cross(at(i + 2))) / 6
  return Math.abs(v)
}

async function fingerprint(geo: THREE.BufferGeometry, joints: BallJoint[], baseRadius: number): Promise<Fingerprint> {
  const log = console.log
  const warn = console.warn
  console.log = () => {}
  console.warn = () => {}
  const { parts, cut, warnings } = await cutAndSplitModel(geo, joints as never, baseRadius, undefined, 'pla')
  console.log = log
  console.warn = warn
  const pieces = parts.map((g) => {
    g.computeBoundingBox()
    const b = g.boundingBox!
    return [volume(g), b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((n) => +n.toFixed(4))
  })
  pieces.sort((a, b) => a[0] - b[0] || a[3] - b[3])
  cut.dispose()
  for (const g of parts) g.dispose()
  return { parts: parts.length, pieces, warnings }
}

const joint = (id: number, position: [number, number, number], axis: Axis, scale: number): BallJoint => ({
  id,
  position,
  axis,
  scale,
  rotation: 0,
  tilt: [0, 0, 0],
})

async function cases(): Promise<Record<string, Fingerprint>> {
  const out: Record<string, Fingerprint> = {}

  // Neck-style: two limbs along Z on the midline.
  {
    const g = mergeGeometries([rod(4, 20, 'z', [0, 0, 10.5]), rod(4, 20, 'z', [0, 0, -10.5]), rod(4, 1.2, 'z', [0, 0, 0])], false)!
    out['neck limbs'] = await fingerprint(g, [joint(1, [0, 0, 0], 'z', 1.3)], 3)
    g.dispose()
  }
  // Shoulder-style: a fat body and a thin arm along X, off the midline.
  {
    const g = mergeGeometries([rod(7, 24, 'x', [0, 0, 0]), rod(3.5, 16, 'x', [20.5, 0, 0])], false)!
    out['shoulder arm'] = await fingerprint(g, [joint(1, [12.25, 0, 0], 'x', 1.1)], 3)
    g.dispose()
  }
  // The user's model: neck + both shoulders at their hand-placed spots, fixed sizes.
  if (fs.existsSync(DAG4)) {
    const buf = fs.readFileSync(DAG4)
    const g = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    g.computeVertexNormals()
    g.center()
    g.computeBoundingBox()
    const s = g.boundingBox!.getSize(new THREE.Vector3())
    const baseRadius = Math.max(Math.min(s.x, s.y, s.z) * 0.12, 1e-3)
    out['Dag 4in neck + shoulders'] = await fingerprint(
      g,
      [joint(1, [-0.32, 1.36, 9.87], 'z', 1.2), joint(2, [-11.94, -3.38, 4.32], 'x', 2), joint(3, [13.29, -0.79, 2.04], 'x', 2)],
      baseRadius,
    )
    g.dispose()
  }
  return out
}

const now = await cases()

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n')
  console.log('Wrote', BASELINE, Object.keys(now).join(', '))
} else {
  const want = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, Fingerprint>
  let fails = 0
  for (const [name, base] of Object.entries(want)) {
    const got = now[name]
    if (!got) {
      console.log(`skip ${name} — input not found`)
      continue
    }
    const same =
      got.parts === base.parts &&
      got.pieces.length === base.pieces.length &&
      got.pieces.every((p, i) => p.every((v, k) => Math.abs(v - base.pieces[i][k]) <= 1e-3 + Math.abs(base.pieces[i][k]) * 1e-6))
    console.log(`${same ? 'OK  ' : 'FAIL'} ${name} — ${got.parts} parts, volumes ${got.pieces.map((p) => p[0]).join(' / ')}`)
    if (!same) {
      fails++
      console.log('     locked:', JSON.stringify(base.pieces))
      console.log('     now:   ', JSON.stringify(got.pieces))
    }
  }
  if (fails === 0) console.log('\nBALL LOCKED OK — identical to the print-tested engine')
  else {
    console.log(`\nBALL LOCKED FAILED (${fails}) — something changed the tested ball joint`)
    process.exitCode = 1
  }
}
