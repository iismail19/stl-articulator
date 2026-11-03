/**
 * Headless cut test for fixtures/DAG.stl
 * Run: npx tsx scripts/test-dag.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import {
  clampJointScales,
  enlargeJoints,
  measureClearanceRadius,
  prepareProbeMesh,
  refitJointsToLimbs,
} from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import type { CutAxis, Joint } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const stlPath =
  process.argv[2] ?? path.join(__dirname, '../fixtures/DAG.stl')

function log(msg: string) {
  const t = new Date().toISOString().slice(11, 19)
  console.log(`[${t}] ${msg}`)
}

function triangleCount(geo: THREE.BufferGeometry): number {
  const index = geo.getIndex()
  if (index) return Math.floor(index.count / 3)
  return Math.floor(geo.getAttribute('position').count / 3)
}

function partStats(parts: THREE.BufferGeometry[], modelSize: number) {
  return parts.map((p, i) => {
    p.computeBoundingBox()
    const box = p.boundingBox!
    const size = box.max.clone().sub(box.min)
    const maxD = Math.max(size.x, size.y, size.z)
    const minD = Math.min(size.x, size.y, size.z)
    return {
      i,
      tris: triangleCount(p),
      size: [size.x, size.y, size.z].map((n) => +n.toFixed(3)),
      spherical: +(minD / Math.max(maxD, 1e-9)).toFixed(2),
      fracOfModel: +(maxD / modelSize).toFixed(2),
    }
  })
}

/** Snap (x,y) onto front surface and nudge inside along −Z. */
function snapInside(
  mesh: THREE.Mesh,
  x: number,
  y: number,
  box: THREE.Box3,
): THREE.Vector3 | null {
  const size = box.max.clone().sub(box.min)
  const raycaster = new THREE.Raycaster()
  ;(raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
  raycaster.far = size.z * 3
  raycaster.set(
    new THREE.Vector3(x, y, box.max.z + size.z),
    new THREE.Vector3(0, 0, -1),
  )
  const hit = raycaster.intersectObject(mesh, false)[0]
  if (!hit) return null
  return hit.point.clone().add(new THREE.Vector3(0, 0, -Math.max(size.z * 0.04, 0.012)))
}

/**
 * Limb joints from mesh analysis of DAG:
 * arms at outer X / mid-upper Y; legs at mid-lower Y / offset X — IN the limb, not pelvis.
 */
function dagLimbJoints(
  mesh: THREE.Mesh,
  box: THREE.Box3,
  baseRadius: number,
  modelSize: number,
): Joint[] {
  const seeds: { x: number; y: number; axis: CutAxis }[] = [
    { x: -0.205, y: 0.2, axis: 'x' },
    { x: 0.205, y: 0.2, axis: 'x' },
    { x: -0.143, y: -0.32, axis: 'y' },
    { x: 0.143, y: -0.32, axis: 'y' },
  ]

  const joints: Joint[] = []
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]
    const p = snapInside(mesh, s.x, s.y, box)
    if (!p) {
      log(`  seed ${i + 1} (${s.x},${s.y}) missed mesh`)
      continue
    }
    const r = measureClearanceRadius(mesh, p, s.axis, modelSize)
    const scale = Math.min(Math.max(r / baseRadius, 0.25), 2.2)
    joints.push({
      id: i + 1,
      position: [p.x, p.y, p.z],
      axis: s.axis,
      scale,
      rotation: 0,
    })
    log(
      `  seed ${i + 1} snapped [${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}] r=${r.toFixed(3)} scale=${scale.toFixed(2)}`,
    )
  }
  return joints
}

async function main() {
  if (!fs.existsSync(stlPath)) {
    console.error(`Missing STL: ${stlPath}`)
    process.exit(1)
  }

  log(`Loading ${stlPath} (${(fs.statSync(stlPath).size / 1e6).toFixed(1)} MB)…`)
  const buf = fs.readFileSync(stlPath)
  const geometry = new STLLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  )
  geometry.computeVertexNormals()
  geometry.center()
  geometry.computeBoundingBox()

  const box = geometry.boundingBox!
  const size: [number, number, number] = [
    box.max.x - box.min.x,
    box.max.y - box.min.y,
    box.max.z - box.min.z,
  ]
  const modelSize = Math.max(...size)
  const baseRadius = suggestBaseRadius(size)
  log(
    `Mesh: ${triangleCount(geometry).toLocaleString()} tris, size ${size.map((n) => n.toFixed(3)).join('×')}, baseR=${baseRadius.toFixed(4)}`,
  )

  const mesh = prepareProbeMesh(geometry)
  log('Placing limb-local joints (snapped inside mesh)…')
  let joints = dagLimbJoints(mesh, box, baseRadius, modelSize)
  const maxScale = Math.min(2.4, (modelSize * 0.1) / Math.max(baseRadius, 1e-9))
  joints = clampJointScales(refitJointsToLimbs(mesh, joints, baseRadius, modelSize), maxScale)

  log(`Joints (${joints.length}):`)
  for (const j of joints) {
    const r = baseRadius * j.scale
    log(
      `  #${j.id} pos=[${j.position.map((n) => n.toFixed(3)).join(',')}] axis=${j.axis} scale=${j.scale.toFixed(2)} r=${r.toFixed(3)} (${((r / modelSize) * 100).toFixed(1)}% of model)`,
    )
  }

  log('Cutting…')
  const tCut = Date.now()
  let { cut, parts } = await cutAndSplitModel(geometry, joints, baseRadius, (p) =>
    log(`  ${p.label}`),
  )

  // Treat scrap chips as failure — need real limb-sized pieces
  const significant = () =>
    parts.filter((p) => {
      p.computeBoundingBox()
      const s = p.boundingBox!.max.clone().sub(p.boundingBox!.min)
      return Math.max(s.x, s.y, s.z) > modelSize * 0.12
    })

  let grow = 0
  while (significant().length < 3 && grow < 4) {
    grow += 1
    log(
      `Only ${significant().length} significant part(s) (of ${parts.length}) — grow ${grow}/4…`,
    )
    cut.dispose()
    for (const p of parts) p.dispose()
    joints = clampJointScales(enlargeJoints(joints, 1.25, maxScale), maxScale)
    for (const j of joints) {
      log(`  #${j.id} scale=${j.scale.toFixed(2)} r=${(baseRadius * j.scale).toFixed(3)}`)
    }
    ;({ cut, parts } = await cutAndSplitModel(geometry, joints, baseRadius, (p) =>
      log(`  ${p.label}`),
    ))
  }

  log(`Cut done in ${((Date.now() - tCut) / 1000).toFixed(1)}s`)
  const stats = partStats(parts, modelSize)
  log(`RESULT: ${parts.length} part(s), ${significant().length} significant`)
  console.log(JSON.stringify(stats, null, 2))

  const blobs = stats.filter((p) => p.fracOfModel > 0.25 && p.spherical > 0.75)
  const sig = significant().length
  if (sig < 3) {
    log('FAIL: did not get multiple limb-sized parts')
    process.exitCode = 2
  } else if (blobs.length >= 2) {
    log(`WARN: ${blobs.length} blob-like parts`)
    process.exitCode = 3
  } else {
    log('OK: multiple significant parts, no torso blobs')
  }

  const outDir = path.join(__dirname, '../fixtures/dag-test-out')
  fs.mkdirSync(outDir, { recursive: true })
  for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f))
  const exporter = new STLExporter()
  parts.forEach((p, i) => {
    const data = exporter.parse(new THREE.Mesh(p), { binary: true }) as DataView
    fs.writeFileSync(
      path.join(outDir, `part-${i}.stl`),
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    )
  })
  log(`Wrote parts to ${outDir}`)

  cut.dispose()
  for (const p of parts) p.dispose()
  geometry.dispose()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
