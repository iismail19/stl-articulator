/**
 * Flip 180° (Joint.swapSides) trades which part gets the hardware.
 * Two equal round limbs, one marker; for ball / hinge / knuckle:
 *   - automatic and flipped both cut into two parts with no warnings
 *   - flipped mirrors the volume split: the part that lost material
 *     (socket / hole / fork) now gains it (ball / peg / tongue) and vice versa
 *   - swapSides: false is identical to leaving it unset
 *
 *   npx tsx scripts/prove-flip.mts
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import type { Joint, JointKind } from '../src/types.ts'

let fails = 0
function ok(name: string, pass: boolean, detail = '') {
  if (pass) console.log(`OK   ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    fails++
  }
}

function twoLimbs(): THREE.BufferGeometry {
  const r = 4
  const a = new THREE.CylinderGeometry(r, r, 20, 40)
  a.rotateX(Math.PI / 2)
  a.translate(0, 0, 10.5)
  const b = new THREE.CylinderGeometry(r, r, 20, 40)
  b.rotateX(Math.PI / 2)
  b.translate(0, 0, -10.5)
  const bridge = new THREE.CylinderGeometry(r, r, 1.2, 40)
  bridge.rotateX(Math.PI / 2)
  const merged = mergeGeometries([a, b, bridge].map((g) => g.toNonIndexed()), false)
  if (!merged) throw new Error('merge failed')
  return merged
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

/** Upper part volume minus lower part volume, or null if the cut didn't make two parts. */
async function split(kind: JointKind, swapSides: boolean | undefined) {
  const joint: Joint = {
    id: 1,
    position: [0, 0, 0],
    axis: 'z',
    scale: 1.3,
    rotation: 0,
    tilt: [0, 0, 0],
    kind,
    ...(swapSides === undefined ? {} : { swapSides }),
  }
  const geo = twoLimbs()
  const { parts, warnings, cut } = await cutAndSplitModel(geo, [joint], 3, undefined, 'pla')
  geo.dispose()
  cut.dispose()
  let diff: number | null = null
  if (parts.length === 2) {
    const z = parts.map((g) => {
      g.computeBoundingBox()
      return g.boundingBox!.getCenter(new THREE.Vector3()).z
    })
    const [up, lo] = z[0] > z[1] ? [parts[0], parts[1]] : [parts[1], parts[0]]
    diff = volume(up) - volume(lo)
  }
  for (const g of parts) g.dispose()
  return { diff, warnings, count: parts.length }
}

for (const kind of ['ball', 'hinge', 'knuckle'] as const) {
  console.log(`\n— ${kind}`)
  const unset = await split(kind, undefined)
  const off = await split(kind, false)
  const on = await split(kind, true)
  ok('automatic: two parts, no warnings', unset.count === 2 && unset.warnings.length === 0, unset.warnings.join(' | '))
  ok('flipped: two parts, no warnings', on.count === 2 && on.warnings.length === 0, on.warnings.join(' | '))
  ok('swapSides false = unset', off.diff === unset.diff, `${off.diff} vs ${unset.diff}`)
  if (unset.diff == null || on.diff == null) continue
  const mirrored =
    Math.sign(unset.diff) === -Math.sign(on.diff) &&
    Math.abs(Math.abs(unset.diff) - Math.abs(on.diff)) < Math.abs(unset.diff) * 0.1
  ok(
    'flip trades the hardware between the parts',
    mirrored,
    `upper − lower: automatic ${unset.diff.toFixed(2)}, flipped ${on.diff.toFixed(2)} mm³`,
  )
}

if (fails === 0) {
  console.log('\nFLIP PROOF OK')
} else {
  console.log(`\nFLIP PROOF FAILED (${fails})`)
  process.exitCode = 1
}
