/**
 * The marker's see-through ball shows the side the cut really puts the socket on.
 *   - two round limbs, every kind, automatic and flipped: the engine's reported
 *     socket side is the part that lost material, and the marker's guess agrees
 *   - Dag 4 inch and DAG.stl with Auto-Suggest joints: guess = engine, joint by joint
 *
 *   npx tsx scripts/prove-marker-side.mts
 */
import fs from 'node:fs'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { figureAxes } from '../src/lib/cutterGeometry.ts'
import { suggestFigureJoints } from '../src/lib/figureTemplate.ts'
import { predictSocketSide } from '../src/lib/hostSide.ts'
import { hintToJoint, prepareProbeMesh, refitJointsToLimbs } from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import type { Joint, JointKind } from '../src/types.ts'

let fails = 0
function ok(name: string, pass: boolean, detail = '') {
  if (pass) console.log(`OK   ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    fails++
  }
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

function twoLimbs(): THREE.BufferGeometry {
  const parts = [10.5, -10.5].map((z) => {
    const c = new THREE.CylinderGeometry(4, 4, 20, 40)
    c.rotateX(Math.PI / 2)
    c.translate(0, 0, z)
    return c.toNonIndexed()
  })
  const bridge = new THREE.CylinderGeometry(4, 4, 1.2, 40)
  bridge.rotateX(Math.PI / 2)
  return mergeGeometries([...parts, bridge.toNonIndexed()], false)!
}

console.log('— two limbs')
for (const kind of ['ball', 'hinge', 'knuckle'] as JointKind[]) {
  for (const swapSides of [false, true]) {
    const joint: Joint = { id: 1, position: [0, 0, 0], axis: 'z', scale: 1.3, rotation: 0, tilt: [0, 0, 0], kind, swapSides }
    const geo = twoLimbs()
    const { parts, socketSides, cut } = await cutAndSplitModel(geo, [joint], 3, undefined, 'pla')
    const side = socketSides?.[1]
    const z = parts.map((g) => {
      g.computeBoundingBox()
      return g.boundingBox!.getCenter(new THREE.Vector3()).z
    })
    // Axis Z, no tilt: the cut normal is +Z, so side +1 = the upper part.
    const [up, lo] = z[0] > z[1] ? [parts[0], parts[1]] : [parts[1], parts[0]]
    const socketIsUpper = volume(up) < volume(lo)
    const guess = predictSocketSide(joint, [joint], 41.2)
    ok(
      `${kind}${swapSides ? ' flipped' : ''}: socket side is the part that lost material`,
      parts.length === 2 && side === (socketIsUpper ? 1 : -1),
      `engine ${side}, socket in ${socketIsUpper ? 'upper' : 'lower'} part`,
    )
    ok(`${kind}${swapSides ? ' flipped' : ''}: marker guess = engine`, guess === side, `guess ${guess}`)
    geo.dispose()
    cut.dispose()
    for (const g of parts) g.dispose()
  }
}

function load(file: string) {
  const buf = fs.readFileSync(file)
  const geo = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  geo.computeVertexNormals()
  geo.center()
  geo.computeBoundingBox()
  return geo
}

for (const file of ['/Users/wind/Downloads/Dag_natural_happy_4inch.stl', 'fixtures/DAG.stl']) {
  if (!fs.existsSync(file)) {
    console.log(`\nskip ${file} — not found`)
    continue
  }
  console.log(`\n— ${file.split('/').pop()}`)
  const geo = load(file)
  const size = geo.boundingBox!.getSize(new THREE.Vector3())
  const modelSize = Math.max(size.x, size.y, size.z)
  const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
  const probe = prepareProbeMesh(geo)
  const hints = suggestFigureJoints(probe, modelSize)
  const auto = refitJointsToLimbs(
    probe,
    hints.map((h, i) => hintToJoint(h, i + 1, baseRadius, h.kind)),
    baseRadius,
    modelSize,
  )
  for (const swapSides of [false, true]) {
    const joints = auto.map((j) => ({ ...j, swapSides }))
    const { parts, socketSides, cut, warnings } = await cutAndSplitModel(geo, joints, baseRadius, undefined, 'pla')
    cut.dispose()
    for (const g of parts) g.dispose()
    ok(`every Auto-Suggest joint got hardware${swapSides ? ' (flipped)' : ''}`, warnings.length === 0, warnings.join(' | '))
    const figure = figureAxes([size.x, size.y, size.z])
    // Dag 4 inch is Z-up: the engine's automatic choices from before up-axis awareness.
    if (file.includes('4inch') && !swapSides) {
      const was = [1, 1, -1, -1, -1, -1, -1]
      const now = joints.map((j) => socketSides?.[j.id])
      ok('Z-up model: automatic sides unchanged', now.every((s, i) => s === was[i]), now.join(' '))
    }
    joints.forEach((j, i) => {
      const guess = predictSocketSide(j, joints, modelSize, figure)
      // The locked ball keeps its Z-up host rules, so on a Y-up export the neck
      // falls to "bigger piece" — unknowable before the cut. The marker shows the
      // engine's real side after a preview.
      if (figure.up !== 'z' && j.kind === 'ball' && hints[i].name === 'neck') {
        console.log(`NOTE ${hints[i].name} #${j.id} (ball, ${j.axis}) — pre-preview guess ${guess}, engine ${socketSides?.[j.id]} (bigger-piece rule)`)
        return
      }
      ok(
        `${hints[i].name} #${j.id} (${j.kind}, ${j.axis})${swapSides ? ' flipped' : ''}: marker guess = engine`,
        socketSides?.[j.id] === guess,
        `engine ${socketSides?.[j.id]}, guess ${guess}`,
      )
    })
  }
}

if (fails === 0) {
  console.log('\nMARKER SIDE OK')
} else {
  console.log(`\nMARKER SIDE FAILED (${fails})`)
  process.exitCode = 1
}
