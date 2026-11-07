/**
 * Swivel on a model cut: two round limbs + one swivel marker.
 *   - two body parts, no separate pin, no failure warnings
 *   - the post fits its hole: straight, only the lip clamp ring overlaps
 *   - twisted all the way round, still only the clamp ring overlaps
 *   - the collars fill the cut gap, so the limb looks whole
 *   - thin limbs get a "Heads up"; limbs too thin for a post get a clear warning
 *
 *   npx tsx scripts/prove-swivel-cut.mts
 */
import Module from 'manifold-3d'
import type { Mat4 } from 'manifold-3d'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { swivelLayout, type SwivelSpec } from '../src/lib/swivelProfile.ts'
import type { Joint } from '../src/types.ts'

let fails = 0
function ok(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) fails++
}

/** One straight round limb, cut in the middle. */
function twoLimbs(r: number, scale: number): THREE.BufferGeometry {
  const len = Math.max(41, r * 6) * scale
  const limb = new THREE.CylinderGeometry(r * scale, r * scale, len, 48)
  limb.rotateX(Math.PI / 2)
  return limb
}

const wasm = await Module()
wasm.setup()
const { Manifold, Mesh } = wasm

function toSolid(g: THREE.BufferGeometry) {
  const m = mergeVertices(g.clone(), 1e-7)
  const pos = m.getAttribute('position') as THREE.BufferAttribute
  const vertProperties = new Float32Array(pos.array)
  const triVerts = new Uint32Array(m.getIndex()!.array)
  m.dispose()
  return new Manifold(new Mesh({ numProp: 3, vertProperties, triVerts }))
}
const vol = (s: ReturnType<typeof toSolid>) => (s.isEmpty() ? 0 : s.volume())

type Case = { label: string; r: number; scale: number; jointScale: number; offset?: [number, number]; expect: 'ok' | 'caution' | 'tooThin' }

async function run(c: Case) {
  console.log(`\n— ${c.label}`)
  const s = c.scale
  const joint: Joint = {
    id: 1,
    position: [(c.offset?.[0] ?? 0) * s, (c.offset?.[1] ?? 0) * s, 0],
    axis: 'z',
    scale: c.jointScale,
    rotation: 0,
    tilt: [0, 0, 0],
    kind: 'swivel',
  }
  const geo = twoLimbs(c.r, s)
  geo.computeBoundingBox()
  const modelSize = geo.boundingBox!.getSize(new THREE.Vector3()).toArray().reduce((a, b) => Math.max(a, b))
  const dbg = globalThis as { __ARTIC_DEBUG?: boolean; __ARTIC_SWIVELS?: { spec: SwivelSpec }[] }
  dbg.__ARTIC_DEBUG = true
  dbg.__ARTIC_SWIVELS = []
  const log = console.log
  const warnLog = console.warn
  console.log = () => {}
  console.warn = () => {}
  const { parts, warnings, notes, cut, ...rest } = await cutAndSplitModel(geo, [joint], 3 * s, undefined, 'pla')
  console.log = log
  console.warn = warnLog
  dbg.__ARTIC_DEBUG = false
  cut.dispose()

  ok('two body parts', parts.length === 2, `${parts.length}`)
  if (c.expect === 'tooThin') {
    ok('clear "too thin" warning', warnings.some((w) => /too thin here for a swivel/.test(w)), warnings.join(' | '))
    return
  }
  ok('no separate pin in the result', !('pins' in rest))
  ok('no failure warnings', warnings.length === 0, warnings.join(' | '))
  ok('snap note, no glue', notes.some((n) => /swivel/i.test(n) && /no glue/i.test(n)), notes.join(' | '))
  const fragile = notes.some((n) => /swivel post is only/.test(n))
  ok(c.expect === 'caution' ? 'thin-post heads up' : 'no thin-post heads up', fragile === (c.expect === 'caution'))
  const spec = dbg.__ARTIC_SWIVELS[0]?.spec
  ok('swivel was built', !!spec)
  if (parts.length !== 2 || !spec) return

  // mm → world units ("print at 100 mm" for tiny exports).
  const k = modelSize < 20 ? modelSize / 100 : 1
  const L = swivelLayout(spec)
  const clampRing = Math.PI * (L.lipR ** 2 - L.holeR ** 2) * spec.shoulderPreload * k ** 3
  console.log(`     collar Ø${(spec.collarRadius * 2).toFixed(2)} mm, post Ø${spec.postDiameter.toFixed(2)} mm, clamp ring ${(clampRing / k ** 3).toFixed(4)} mm³`)

  const solids = parts.map(toSolid)
  const straight = (() => {
    const hit = Manifold.intersection(solids[0], solids[1])
    const v = vol(hit)
    hit.delete()
    return v
  })()
  ok('straight: only the lip clamp overlaps', straight > 0 && straight <= clampRing * 1.6 + 1e-9, `${(straight / k ** 3).toFixed(4)} mm³`)

  // Twist about the limb's axis (the limb center, wherever the marker sat).
  for (const deg of [30, 90, 180, 270]) {
    const m = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(deg))
    const turned = solids[1].transform(m.elements as unknown as Mat4)
    const hit = Manifold.intersection(solids[0], turned)
    const v = vol(hit)
    hit.delete()
    turned.delete()
    ok(`twist ${deg}° — still only the clamp`, v <= clampRing * 1.6 + 1e-9, `${(v / k ** 3).toFixed(4)} mm³`)
  }

  // The cut gap inside the collar is filled: a thin slab across the joint is mostly material.
  // The post's split runs up into the collar on purpose; leave it out of the probe.
  const probeR = spec.collarRadius * 0.8 * k
  const disk = Manifold.cylinder(0.6 * k * 2, probeR, probeR, 48, true)
  const slotOut = Manifold.cube([spec.splitWidth * k, (L.lipR + 0.5) * 2 * k, 10 * k], true)
  const probe = Manifold.difference(disk, slotOut)
  disk.delete()
  slotOut.delete()
  const filled = solids.reduce((sum, sol) => {
    const hit = Manifold.intersection(sol, probe)
    const v = vol(hit)
    hit.delete()
    return sum + v
  }, 0)
  const frac = filled / vol(probe)
  ok('collars fill the cut gap', frac > 0.95, `${(frac * 100).toFixed(1)}% solid`)
  probe.delete()
  for (const sol of solids) sol.delete()
  for (const p of parts) p.dispose()
}

await run({ label: 'Ø8 mm limbs (forearm)', r: 4, scale: 1, jointScale: 1.3, expect: 'ok' })
await run({ label: 'Ø8 limbs, 1-unit export', r: 4, scale: 0.01, jointScale: 1.3, expect: 'ok' })
await run({ label: 'Ø8 limbs, marker 1 mm off-center', r: 4, scale: 1, jointScale: 1.3, offset: [1, 0.6], expect: 'ok' })
await run({ label: 'Ø24 mm waist', r: 12, scale: 1, jointScale: 4, expect: 'ok' })
await run({ label: 'Ø5 mm thin limb', r: 2.5, scale: 1, jointScale: 0.85, expect: 'caution' })
await run({ label: 'Ø3 mm wire-thin limb', r: 1.5, scale: 1, jointScale: 0.5, expect: 'tooThin' })

if (fails === 0) console.log('\nSWIVEL CUT OK')
else {
  console.log(`\nSWIVEL CUT FAILED (${fails})`)
  process.exitCode = 1
}
