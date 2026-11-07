/**
 * Hinge on a model cut: two round limbs + one hinge marker.
 * Proves the snap-disc hinge is really there and really bends:
 *   - two body parts, no separate pin
 *   - one part carries the peg, the other has an open hole around it
 *   - the parts only touch at the lip clamp, straight and bent to 45° / 90°
 *
 *   npx tsx scripts/prove-hinge-cut.mts
 */
import Module from 'manifold-3d'
import type { Mat4 } from 'manifold-3d'
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { jointLocalToWorld } from '../src/lib/cutterGeometry.ts'
import { cylY } from '../src/lib/hingeGeometry.ts'
import { hingeDimsForJoint, hingeLayout } from '../src/lib/hingeProfile.ts'
import type { Joint } from '../src/types.ts'

let fails = 0
function ok(name: string, pass: boolean, detail = '') {
  if (pass) console.log(`OK   ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    fails++
  }
}

const LIMB_R = 3.5
function twoLimbs(): THREE.BufferGeometry {
  const a = new THREE.CylinderGeometry(LIMB_R, LIMB_R, 20, 40)
  a.rotateX(Math.PI / 2)
  a.translate(0, 0, 10.5)
  const b = new THREE.CylinderGeometry(LIMB_R, LIMB_R, 20, 40)
  b.rotateX(Math.PI / 2)
  b.translate(0, 0, -10.5)
  const bridge = new THREE.CylinderGeometry(LIMB_R, LIMB_R, 1.2, 40)
  bridge.rotateX(Math.PI / 2)
  const merged = mergeGeometries(
    [a, b, bridge].map((g) => g.toNonIndexed()),
    false,
  )
  if (!merged) throw new Error('merge failed')
  return merged
}

const joint: Joint = {
  id: 1,
  position: [0, 0, 0],
  axis: 'z',
  scale: 1.2,
  rotation: 0,
  tilt: [0, 0, 0],
  kind: 'hinge',
}
const baseRadius = 3

const geo = twoLimbs()
const { parts, warnings, notes, cut, ...rest } = await cutAndSplitModel(
  geo,
  [joint],
  baseRadius,
  undefined,
  'pla',
)
geo.dispose()
cut.dispose()

ok('two body parts', parts.length === 2, `${parts.length}`)
ok('no separate pin in the result', !('pins' in rest) && !('pinsPrint' in rest))
ok('no failure warnings', warnings.length === 0, warnings.join(' | '))
ok('snap note, no glue', notes.some((n) => /snap|click/i.test(n) && /no glue/i.test(n)))

const wasm = await Module()
wasm.setup()
const { Manifold, Mesh } = wasm

function toSolid(g: THREE.BufferGeometry) {
  let m = mergeVertices(g.clone(), 1e-4)
  if (!m.getIndex()) {
    const n = m.getAttribute('position').count
    m.setIndex(Array.from({ length: n }, (_, i) => i))
  }
  const pos = m.getAttribute('position') as THREE.BufferAttribute
  const index = m.getIndex()!
  const vertProperties = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    vertProperties[i * 3] = pos.getX(i)
    vertProperties[i * 3 + 1] = pos.getY(i)
    vertProperties[i * 3 + 2] = pos.getZ(i)
  }
  const triVerts = new Uint32Array(index.count)
  for (let i = 0; i < index.count; i++) triVerts[i] = index.getX(i)
  m.dispose()
  return new Manifold(new Mesh({ numProp: 3, vertProperties, triVerts }))
}

const toWorld = jointLocalToWorld(joint)
const solids = parts.map(toSolid)
const H = hingeDimsForJoint(baseRadius * joint.scale)
const L = hingeLayout(H)

// Peg probe: thin rod on the hinge axis, inside the eye disc's thickness.
const probe = cylY(Manifold, L.eye[0] + 0.15, L.eye[1] - 0.15, L.pegR * 0.5).transform(
  toWorld.elements as unknown as Mat4,
)
const hits = solids.map((s) => {
  const i = Manifold.intersection(s, probe)
  const v = i.isEmpty() ? 0 : i.volume()
  i.delete()
  return v
})
probe.delete()
const studIdx = hits.findIndex((v) => v > 0.01)
const eyeIdx = studIdx === 0 ? 1 : 0
ok('one part carries the peg', hits.filter((v) => v > 0.01).length === 1, hits.map((v) => v.toFixed(3)).join(' / '))
ok('the other part has an open hole', hits[eyeIdx] === 0)

// Bend the eye part about the hinge axis and check the parts don't collide.
const clampVol = Math.PI * (L.lipR ** 2 - L.holeR ** 2) * H.shoulderPreload
const inv = toWorld.clone().invert()
for (const deg of [0, 45, 90, -45]) {
  const spin = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(deg))
  const m = toWorld.clone().multiply(spin).multiply(inv)
  const swung = solids[eyeIdx].transform(m.elements as unknown as Mat4)
  const hit = Manifold.intersection(solids[studIdx], swung)
  const v = hit.isEmpty() ? 0 : hit.volume()
  hit.delete()
  swung.delete()
  ok(`bend ${deg}° — parts don't collide`, v <= clampVol * 1.6 + 0.02, `overlap ${v.toFixed(3)} mm³, lip clamp ${clampVol.toFixed(3)}`)
}

for (const s of solids) s.delete()
for (const p of parts) p.dispose()

if (fails === 0) {
  console.log('\nHINGE CUT OK')
  process.exitCode = 0
} else {
  console.log(`\nHINGE CUT FAILED (${fails})`)
  process.exitCode = 1
}
