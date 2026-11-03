/**
 * Find where DAG.stl has material — cross-section radii.
 * Run: npx tsx scripts/analyze-dag.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { measureClearanceRadius, prepareProbeMesh } from '../src/lib/meshProbe.ts'
import type { CutAxis } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const stlPath = path.join(__dirname, '../fixtures/DAG.stl')

async function main() {
  const buf = fs.readFileSync(stlPath)
  const geometry = new STLLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  )
  geometry.computeVertexNormals()
  geometry.center()
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  const size = box.max.clone().sub(box.min)
  const modelSize = Math.max(size.x, size.y, size.z)
  console.log(`size ${[size.x, size.y, size.z].map((n) => n.toFixed(3)).join('×')}`)

  const mesh = prepareProbeMesh(geometry)
  const raycaster = new THREE.Raycaster()
  ;(raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true

  function hitFrom(origin: THREE.Vector3, dir: THREE.Vector3, far: number) {
    raycaster.far = far
    raycaster.set(origin, dir.clone().normalize())
    return raycaster.intersectObject(mesh, false)[0]
  }

  function sampleInside(
    x: number,
    y: number,
  ): THREE.Vector3 | null {
    const from = new THREE.Vector3(x, y, box.max.z + size.z)
    const hit = hitFrom(from, new THREE.Vector3(0, 0, -1), size.z * 3)
    if (!hit) return null
    // Nudge inward along -Z past the front surface
    return hit.point.clone().add(new THREE.Vector3(0, 0, -Math.max(size.z * 0.03, 0.01)))
  }

  console.log('\n=== Height sweep (Y) — clearance for cut axis Y ===')
  for (let i = 0; i <= 20; i++) {
    const y = box.min.y + (size.y * i) / 20
    const xs = [0, -0.2, 0.2, -0.35, 0.35].map((f) => f * size.x)
    let best = { r: -1, p: null as THREE.Vector3 | null, axis: 'y' as CutAxis }
    for (const x of xs) {
      const p = sampleInside(x, y)
      if (!p) continue
      for (const axis of ['x', 'y', 'z'] as CutAxis[]) {
        const r = measureClearanceRadius(mesh, p, axis, modelSize)
        if (r > best.r) best = { r, p, axis }
      }
    }
    if (!best.p) {
      console.log(`y=${y.toFixed(3)} no hit`)
      continue
    }
    console.log(
      `y=${y.toFixed(3)} bestR=${best.r.toFixed(3)} axis=${best.axis} at [${best.p.x.toFixed(3)},${best.p.y.toFixed(3)},${best.p.z.toFixed(3)}]`,
    )
  }

  console.log('\n=== Shoulder band Y=0.15..0.25, X sweep ===')
  for (const y of [0.12, 0.18, 0.22, 0.28]) {
    for (let i = 0; i <= 14; i++) {
      const x = box.min.x + (size.x * i) / 14
      const p = sampleInside(x, y)
      if (!p) {
        console.log(`y=${y.toFixed(2)} x=${x.toFixed(3)} miss`)
        continue
      }
      const rX = measureClearanceRadius(mesh, p, 'x', modelSize)
      const rY = measureClearanceRadius(mesh, p, 'y', modelSize)
      console.log(
        `y=${y.toFixed(2)} x=${x.toFixed(3)} rX=${rX.toFixed(3)} rY=${rY.toFixed(3)} z=${p.z.toFixed(3)}`,
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
