/**
 * Knuckle on a model cut: two round limbs + one knuckle marker.
 *   - two body parts, no separate pin, no failure warnings
 *   - the fork part carries both bumps; the tongue part has the dimples
 *   - the parts only touch at the bump pinch, straight and bent to ±45° / ±90°
 *
 *   npx tsx scripts/prove-knuckle-cut.mts
 */
import Module from 'manifold-3d'
import type { Mat4 } from 'manifold-3d'
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { jointLocalToWorld } from '../src/lib/cutterGeometry.ts'
import type { Joint } from '../src/types.ts'

let fails = 0
function ok(name: string, pass: boolean, detail = '') {
  if (pass) console.log(`OK   ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    fails++
  }
}

const LIMB_R = 4
function twoLimbs(scale: number): THREE.BufferGeometry {
  const r = LIMB_R * scale
  const a = new THREE.CylinderGeometry(r, r, 20 * scale, 40)
  a.rotateX(Math.PI / 2)
  a.translate(0, 0, 10.5 * scale)
  const b = new THREE.CylinderGeometry(r, r, 20 * scale, 40)
  b.rotateX(Math.PI / 2)
  b.translate(0, 0, -10.5 * scale)
  const bridge = new THREE.CylinderGeometry(r, r, 1.2 * scale, 40)
  bridge.rotateX(Math.PI / 2)
  const merged = mergeGeometries([a, b, bridge].map((g) => g.toNonIndexed()), false)
  if (!merged) throw new Error('merge failed')
  return merged
}

const wasm = await Module()
wasm.setup()
const { Manifold, Mesh } = wasm

function toSolid(g: THREE.BufferGeometry) {
  const m = mergeVertices(g.clone(), 1e-6)
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

/** `scale` 1 = a 42 mm-long mm model; 0.01 = the same shape exported in ~0.4-unit size. */
async function run(label: string, scale: number) {
  console.log(`\n— ${label}`)
  const joint: Joint = {
    id: 1,
    position: [0, 0, 0],
    axis: 'z',
    scale: 1.3,
    rotation: 0,
    tilt: [0, 0, 0],
    kind: 'knuckle',
  }
  const geo = twoLimbs(scale)
  const { parts, warnings, notes, cut, ...rest } = await cutAndSplitModel(
    geo,
    [joint],
    3 * scale,
    undefined,
    'pla',
  )
  geo.dispose()
  cut.dispose()

  ok('two body parts', parts.length === 2, `${parts.length}`)
  ok('no separate pin in the result', !('pins' in rest))
  ok('no failure warnings', warnings.length === 0, warnings.join(' | '))
  ok('snap note, no glue', notes.some((n) => /knuckle/i.test(n) && /no glue/i.test(n)), notes.join(' | '))
  if (parts.length !== 2) return

  const toWorld = jointLocalToWorld(joint)
  const solids = parts.map(toSolid)

  // Bump probe: a thin rod on the bend axis spanning the gap between cheek and tongue faces.
  // Only the fork part (bumps) has material on the axis just inside each cheek face.
  const rod = (y0: number, y1: number) =>
    Manifold.cylinder(y1 - y0, 0.15 * scale, 0.15 * scale, 12)
      .rotate([-90, 0, 0])
      .translate([0, y0, 0])
      .transform(toWorld.elements as unknown as Mat4)
  const axisHits = (y0: number, y1: number) =>
    solids.map((s) => {
      const p = rod(y0, y1)
      const i = Manifold.intersection(s, p)
      const v = i.isEmpty() ? 0 : i.volume()
      i.delete()
      p.delete()
      return v
    })
  // Sweep the whole width along the axis; the tongue's dimples leave it hollow at the axis
  // only where the bumps are, so both parts touch the axis line.
  const span = LIMB_R * scale * 2
  const along = axisHits(-span, span)
  ok('both parts sit on the bend axis', along.every((v) => v > 0), along.map((v) => v.toExponential(2)).join(' / '))

  const inv = toWorld.clone().invert()
  const vol0 = (() => {
    const hit = Manifold.intersection(solids[0], solids[1])
    const v = hit.isEmpty() ? 0 : hit.volume()
    hit.delete()
    return v
  })()
  ok('bumps pinch the tongue (pose hold)', vol0 > 0, `overlap ${vol0.toExponential(2)}`)
  for (const deg of [45, 90, -45, -90]) {
    const spin = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(deg))
    const m = toWorld.clone().multiply(spin).multiply(inv)
    const swung = solids[1].transform(m.elements as unknown as Mat4)
    const hit = Manifold.intersection(solids[0], swung)
    const v = hit.isEmpty() ? 0 : hit.volume()
    hit.delete()
    swung.delete()
    ok(`bend ${deg}° — only the pinch touches`, v <= vol0 * 1.5 + 1e-9, `overlap ${v.toExponential(2)} vs straight ${vol0.toExponential(2)}`)
  }
  for (const s of solids) s.delete()
  for (const p of parts) p.dispose()
}

await run('mm-scale limbs', 1)
await run('unit-scale limbs (1-unit export)', 0.01)

if (fails === 0) {
  console.log('\nKNUCKLE CUT OK')
} else {
  console.log(`\nKNUCKLE CUT FAILED (${fails})`)
  process.exitCode = 1
}
