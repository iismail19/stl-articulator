/**
 * Auto-Suggest lands where a person put the joints by hand.
 * Reference: 7 markers placed on Dag_natural_happy_4inch.stl (neck, 2 shoulders,
 * 2 elbows, 2 knees). Also runs the 1-unit Y-up DAG.stl export of the same robot.
 *
 *   npx tsx scripts/prove-figure-suggest.mts
 */
import fs from 'node:fs'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { suggestFigureJoints } from '../src/lib/figureTemplate.ts'
import { prepareProbeMesh } from '../src/lib/meshProbe.ts'
import type { CutAxis } from '../src/types.ts'

let fails = 0
function ok(name: string, pass: boolean, detail = '') {
  if (pass) console.log(`OK   ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    fails++
  }
}

function load(file: string) {
  const buf = fs.readFileSync(file)
  const geo = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  // Same as the app's loader.
  geo.computeVertexNormals()
  geo.center()
  geo.computeBoundingBox()
  return geo
}

const HAND_PLACED_4IN: { name: string; p: [number, number, number]; axis: CutAxis }[] = [
  { name: 'neck', p: [-0.32, 1.36, 9.87], axis: 'z' },
  { name: 'shoulder', p: [-11.94, -3.38, 4.32], axis: 'x' },
  { name: 'shoulder', p: [13.29, -0.79, 2.04], axis: 'x' },
  { name: 'elbow', p: [-20.89, -2.39, -10.2], axis: 'z' },
  { name: 'elbow', p: [21.45, 2.16, -10.02], axis: 'z' },
  { name: 'knee', p: [-9.61, -5.28, -28.86], axis: 'z' },
  { name: 'knee', p: [10.58, -3.35, -29.37], axis: 'z' },
]

const dag4 = '/Users/wind/Downloads/Dag_natural_happy_4inch.stl'
if (fs.existsSync(dag4)) {
  console.log('— Dag 4 inch (Z-up, mm)')
  const geo = load(dag4)
  const size = geo.boundingBox!.getSize(new THREE.Vector3())
  const modelSize = Math.max(size.x, size.y, size.z)
  const hints = suggestFigureJoints(prepareProbeMesh(geo), modelSize)
  ok('exactly 7 joints', hints.length === 7, `${hints.length}`)
  const tol = modelSize * 0.06
  for (const ref of HAND_PLACED_4IN) {
    const near = hints
      .filter((h) => h.name === ref.name)
      .map((h) => ({ h, d: new THREE.Vector3(...h.position).distanceTo(new THREE.Vector3(...ref.p)) }))
      .sort((a, b) => a.d - b.d)[0]
    ok(
      `${ref.name} at (${ref.p.map((n) => n.toFixed(0)).join(', ')})`,
      !!near && near.d < tol && near.h.axis === ref.axis,
      near ? `off by ${near.d.toFixed(1)} mm (limit ${tol.toFixed(1)}), axis ${near.h.axis}` : 'missing',
    )
  }
} else {
  console.log('skip Dag 4 inch — file not in ~/Downloads')
}

const dagY = 'fixtures/DAG.stl'
if (fs.existsSync(dagY)) {
  console.log('\n— DAG.stl (Y-up, 1 unit)')
  const geo = load(dagY)
  const size = geo.boundingBox!.getSize(new THREE.Vector3())
  const modelSize = Math.max(size.x, size.y, size.z)
  const hints = suggestFigureJoints(prepareProbeMesh(geo), modelSize)
  ok('exactly 7 joints', hints.length === 7, `${hints.length}`)
  const want: Record<string, CutAxis> = { neck: 'y', shoulder: 'x', elbow: 'y', knee: 'y' }
  for (const h of hints) {
    ok(
      `${h.name} axis ${want[h.name].toUpperCase()}`,
      h.axis === want[h.name],
      `${h.axis} at (${h.position.map((n) => n.toFixed(3)).join(', ')})`,
    )
  }
}

if (fails === 0) {
  console.log('\nFIGURE SUGGEST OK')
} else {
  console.log(`\nFIGURE SUGGEST FAILED (${fails})`)
  process.exitCode = 1
}
