/**
 * Simplify Mesh keeps a watertight model watertight, so joints still build.
 * On DAG.stl (and Dag_natural_happy_4inch.stl when present), Medium simplify must:
 *   - reach its triangle target
 *   - stay a closed solid Manifold can read
 *   - keep volume within 2% and the bounding box within 1%
 *   - give an Auto-Suggest cut with no warnings and one part per joint + 1
 *
 *   npx tsx scripts/prove-simplify.mts
 */
import fs from 'node:fs'
import Module from 'manifold-3d'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { suggestFigureJoints } from '../src/lib/figureTemplate.ts'
import { hintToJoint, prepareProbeMesh, refitJointsToLimbs } from '../src/lib/meshProbe.ts'
import { simplifyGeometry, targetForStrength } from '../src/lib/simplifyMesh.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'

let fails = 0
function ok(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) fails++
}

const wasm = await Module()
wasm.setup()

function load(file: string) {
  const buf = fs.readFileSync(file)
  const geo = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  geo.computeVertexNormals()
  geo.center()
  geo.computeBoundingBox()
  return geo
}

/** Volume when Manifold reads the mesh as a closed solid at a tight weld, else null. */
function solidVolume(g: THREE.BufferGeometry, size: number): number | null {
  const m = mergeVertices(g.clone().deleteAttribute('normal'), size * 1e-6)
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(m.getAttribute('position').array),
    triVerts: new Uint32Array(m.getIndex()!.array),
  })
  mesh.merge()
  try {
    const s = new wasm.Manifold(mesh)
    const v = s.volume()
    s.delete()
    return v
  } catch {
    return null
  }
}

const files = ['fixtures/DAG.stl', '/Users/wind/Downloads/Dag_natural_happy_4inch.stl'].filter((f) => fs.existsSync(f))
if (files.length === 0) {
  console.log('No fixture models found — nothing to check.')
  process.exit(1)
}

for (const file of files) {
  console.log(`— ${file}`)
  const geo = load(file)
  const size = geo.boundingBox!.getSize(new THREE.Vector3())
  const modelSize = Math.max(size.x, size.y, size.z)
  const v0 = solidVolume(geo, modelSize)

  const { geometry: simp, before, after, watertight } = await simplifyGeometry(geo, { strength: 'medium' })
  const target = targetForStrength(before, 'medium')
  ok('reaches the Medium target', after <= target, `${before.toLocaleString()} → ${after.toLocaleString()} (target ${target.toLocaleString()})`)
  const v1 = solidVolume(simp, modelSize)
  ok('stays watertight', watertight && v1 != null)
  if (v0 != null && v1 != null) ok('volume within 2%', Math.abs(v1 - v0) / v0 < 0.02, `${(((v1 - v0) / v0) * 100).toFixed(2)}%`)
  simp.computeBoundingBox()
  const drift = Math.max(
    simp.boundingBox!.min.distanceTo(geo.boundingBox!.min),
    simp.boundingBox!.max.distanceTo(geo.boundingBox!.max),
  )
  ok('bounding box within 1%', drift / modelSize < 0.01, `${((drift / modelSize) * 100).toFixed(3)}%`)

  const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
  const probe = prepareProbeMesh(simp)
  const hints = suggestFigureJoints(probe, modelSize)
  const joints = refitJointsToLimbs(probe, hints.map((h, i) => hintToJoint(h, i + 1, baseRadius, h.kind)), baseRadius, modelSize)
  const log = console.log
  console.log = () => {}
  const res = await cutAndSplitModel(simp, joints, baseRadius, undefined, 'pla')
  console.log = log
  // The cut can leave sub-0.01% slivers on DAG.stl even unsimplified; count real parts only.
  const real = res.parts.filter((p) => (solidVolume(p, modelSize) ?? 0) > (v1 ?? 0) * 0.001).length
  ok(
    'Auto-Suggest cut builds every joint',
    res.warnings.length === 0 && real === joints.length + 1,
    `${joints.length} joints → ${real} parts${res.warnings.length ? `; ${res.warnings.join(' | ')}` : ''}`,
  )
  res.cut.dispose()
  for (const g of res.parts) g.dispose()
}

if (fails === 0) console.log('\nSIMPLIFY OK — simplified meshes stay watertight and cut cleanly')
else {
  console.log(`\nSIMPLIFY FAILED (${fails})`)
  process.exitCode = 1
}
