/**
 * Dump which parts the engine would pair at each arm joint (pre / conceptual).
 * Uses the same cut pipeline, then re-scores distances like applyBallAndSocket.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { clampJointScales, prepareProbeMesh, recenterInLimb, refitJointsToLimbs } from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import type { CutAxis, Joint } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const stlPath = path.join(__dirname, '../fixtures/Dag_natural_happy_3inch.stl')

function rayHit(mesh: THREE.Mesh, from: THREE.Vector3, dir: THREE.Vector3, far: number) {
  const ray = new THREE.Raycaster()
  ray.far = far
  ray.set(from, dir.clone().normalize())
  const hit = ray.intersectObject(mesh, false)[0]
  if (!hit) return null
  const normal =
    hit.face?.normal.clone().transformDirection(mesh.matrixWorld).normalize() ??
    dir.clone().negate()
  return { point: hit.point.clone(), normal }
}

function place(
  mesh: THREE.Mesh,
  modelSize: number,
  id: number,
  from: THREE.Vector3,
  dir: THREE.Vector3,
  axis: CutAxis,
  inward: number,
  scale: number,
): Joint | null {
  const hit = rayHit(mesh, from, dir, modelSize * 3)
  if (!hit) return null
  const p = hit.point.clone().addScaledVector(hit.normal, -inward)
  const c = recenterInLimb(mesh, p, axis, modelSize)
  return { id, position: [c.x, c.y, c.z], axis, scale, rotation: 0, tilt: [0, 0, 0] }
}

function distToBox(b: THREE.Box3, p: THREE.Vector3) {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x)
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y)
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z)
  return Math.hypot(dx, dy, dz)
}

async function main() {
  const buf = fs.readFileSync(stlPath)
  const geo = new STLLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  )
  geo.computeVertexNormals()
  geo.center()
  geo.computeBoundingBox()
  const box = geo.boundingBox!
  const size = box.max.clone().sub(box.min)
  const modelSize = Math.max(size.x, size.y, size.z)
  const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
  const mesh = prepareProbeMesh(geo)
  const sx = size.x
  const sy = size.y
  const sz = size.z
  const maxScale = Math.min(3.2, (modelSize * 0.16) / baseRadius)

  const neckC = recenterInLimb(mesh, new THREE.Vector3(0, 0, sz * 0.34), 'z', modelSize)
  let joints = [
    { id: 1, position: [neckC.x, neckC.y, neckC.z], axis: 'z' as const, scale: 2.2, rotation: 0, tilt: [0, 0, 0] },
    place(mesh, modelSize, 2, new THREE.Vector3(-sx, sy * 0.05, sz * 0.15), new THREE.Vector3(1, 0, 0), 'x', 2.5, 2.8),
    place(mesh, modelSize, 3, new THREE.Vector3(sx, sy * 0.05, sz * 0.15), new THREE.Vector3(-1, 0, 0), 'x', 2.5, 2.8),
    place(mesh, modelSize, 4, new THREE.Vector3(-sx, 0, -sz * 0.02), new THREE.Vector3(1, 0, 0), 'x', 2, 1.4),
    place(mesh, modelSize, 5, new THREE.Vector3(sx, 0, -sz * 0.02), new THREE.Vector3(-1, 0, 0), 'x', 2, 1.4),
  ].filter((j): j is Joint => j != null)

  joints = clampJointScales(refitJointsToLimbs(mesh, joints, baseRadius, modelSize), maxScale)
  joints = joints.map((j) => {
    if (j.id === 1) return { ...j, scale: Math.max(j.scale, 2.2) }
    if (j.id === 2 || j.id === 3) return { ...j, scale: Math.max(j.scale, 2.8) }
    return { ...j, scale: Math.max(j.scale, 1.2) }
  })

  // Cut WITHOUT ball/socket to see raw split hosts — booleanCut always adds them.
  // Inspect finished parts' proximity to each joint instead.
  const { parts } = await cutAndSplitModel(geo, joints, baseRadius, undefined, 'pla')

  for (const j of joints) {
    const jp = new THREE.Vector3(...j.position)
    const jR = baseRadius * j.scale
    const axis = j.axis === 'x' ? new THREE.Vector3(1, 0, 0) : j.axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    console.log(`\nJoint #${j.id} ${j.axis} @ ${j.position.map((n) => n.toFixed(2))} jR=${jR.toFixed(2)}`)
    const rows = parts.map((g, i) => {
      g.computeBoundingBox()
      const b = g.boundingBox!
      const s = b.max.clone().sub(b.min)
      const c = b.min.clone().add(b.max).multiplyScalar(0.5)
      const vol = s.x * s.y * s.z
      const dist = distToBox(b, jp)
      const side = Math.sign(c.clone().sub(jp).dot(axis)) || 0
      return { i, vol, dist, side, c }
    })
    rows.sort((a, b) => a.dist - b.dist || b.vol - a.vol)
    for (const r of rows.slice(0, 6)) {
      console.log(
        `  part ${r.i} dist=${r.dist.toFixed(2)} side=${r.side} vol=${r.vol.toFixed(0)} c=(${r.c.x.toFixed(1)},${r.c.y.toFixed(1)},${r.c.z.toFixed(1)})`,
      )
    }
    const touchLimit = Math.max(jR * 0.85, modelSize * 0.02)
    const localLimit = Math.max(jR * 5, modelSize * 0.12)
    const touching = rows.filter((r) => r.dist <= touchLimit && r.vol > 50)
    const bySide = new Map<number, typeof rows>()
    for (const r of rows.filter((r) => r.dist <= localLimit && r.vol > 50)) {
      const list = bySide.get(r.side) ?? []
      list.push(r)
      bySide.set(r.side, list)
    }
    console.log(
      `  touchLimit=${touchLimit.toFixed(2)} touching=[${touching.map((t) => t.i).join(',')}]`,
    )
    for (const [side, list] of bySide) {
      const best = list.sort((a, b) => a.dist - b.dist)[0]
      console.log(`  best side ${side}: part ${best.i} vol=${best.vol.toFixed(0)} dist=${best.dist.toFixed(2)}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
