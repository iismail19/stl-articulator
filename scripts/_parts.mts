import fs from 'node:fs'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { suggestFigureJoints } from '../src/lib/figureTemplate.ts'
import { hintToJoint, prepareProbeMesh, refitJointsToLimbs } from '../src/lib/meshProbe.ts'
import { simplifyGeometry } from '../src/lib/simplifyMesh.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'

const buf = fs.readFileSync('fixtures/DAG.stl')
const geo = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
geo.computeVertexNormals()
geo.center()
geo.computeBoundingBox()
const size = geo.boundingBox!.getSize(new THREE.Vector3())
const modelSize = Math.max(size.x, size.y, size.z)
const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
const vol = (g: THREE.BufferGeometry) => {
  const p = g.getAttribute('position'); const idx = g.getIndex(); const n = idx ? idx.count : p.count
  const at = (i: number) => new THREE.Vector3().fromBufferAttribute(p as THREE.BufferAttribute, idx ? idx.getX(i) : i)
  let v = 0; for (let i = 0; i < n; i += 3) v += at(i).dot(at(i + 1).cross(at(i + 2))) / 6
  return Math.abs(v)
}
for (const label of ['original', 'simplified']) {
  const g = label === 'original' ? geo : (await simplifyGeometry(geo, { strength: 'medium' })).geometry
  const probe = prepareProbeMesh(g)
  const hints = suggestFigureJoints(probe, modelSize)
  const joints = refitJointsToLimbs(probe, hints.map((h, i) => hintToJoint(h, i + 1, baseRadius, h.kind)), baseRadius, modelSize)
  const log = console.log; console.log = () => {}
  const res = await cutAndSplitModel(g, joints, baseRadius, undefined, 'pla')
  console.log = log
  console.log(label, res.parts.length, 'parts', res.parts.map((p) => (vol(p) / vol(g) * 100).toFixed(3) + '%').join(' '), res.warnings)
}
