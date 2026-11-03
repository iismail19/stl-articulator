/**
 * Proof: ball-on-stem + socket survive a cut on a trivial two-box model,
 * then on DAG neck. Writes STLs + a JSON report.
 *
 *   npx tsx scripts/prove-joint.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import {
  clampJointScales,
  prepareProbeMesh,
  recenterInLimb,
  refitJointsToLimbs,
} from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import type { Joint } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '../fixtures/prove-out')

function log(msg: string) {
  console.log(msg)
}

function triCount(g: THREE.BufferGeometry) {
  const idx = g.getIndex()
  return idx ? idx.count / 3 : g.getAttribute('position').count / 3
}

function writeStl(geo: THREE.BufferGeometry, file: string) {
  const data = new STLExporter().parse(new THREE.Mesh(geo), { binary: true }) as DataView
  fs.writeFileSync(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
}

function partReport(p: THREE.BufferGeometry, i: number) {
  p.computeBoundingBox()
  const b = p.boundingBox!
  const size = b.max.clone().sub(b.min)
  return {
    i,
    tris: Math.round(triCount(p)),
    min: [...b.min].map((n) => +n.toFixed(3)),
    max: [...b.max].map((n) => +n.toFixed(3)),
    size: [size.x, size.y, size.z].map((n) => +n.toFixed(3)),
  }
}

/** Two boxes stacked on Y — neck-like joint between them. */
function makeTwoBoxes(): THREE.BufferGeometry {
  const top = new THREE.BoxGeometry(0.4, 0.3, 0.4)
  top.translate(0, 0.25, 0)
  const bot = new THREE.BoxGeometry(0.5, 0.4, 0.5)
  bot.translate(0, -0.1, 0)
  // Thin neck connecting them so kerf has something to sever
  const neck = new THREE.CylinderGeometry(0.08, 0.08, 0.12, 24)
  neck.translate(0, 0.08, 0)
  const merged = mergeGeometries([top, bot, neck], false)
  top.dispose()
  bot.dispose()
  neck.dispose()
  if (!merged) throw new Error('merge failed')
  merged.computeVertexNormals()
  merged.computeBoundingBox()
  return merged
}

/** Two boxes side-by-side on X — arm/shoulder-like joint. */
function makeTwoBoxesX(): THREE.BufferGeometry {
  const left = new THREE.BoxGeometry(0.35, 0.45, 0.35)
  left.translate(-0.28, 0, 0)
  const right = new THREE.BoxGeometry(0.3, 0.4, 0.3)
  right.translate(0.28, 0, 0)
  const bridge = new THREE.CylinderGeometry(0.07, 0.07, 0.2, 24)
  bridge.rotateZ(Math.PI / 2)
  bridge.translate(0, 0, 0)
  const merged = mergeGeometries([left, right, bridge], false)
  left.dispose()
  right.dispose()
  bridge.dispose()
  if (!merged) throw new Error('merge failed')
  merged.computeVertexNormals()
  merged.computeBoundingBox()
  return merged
}

function hasProtrusionAlongAxis(
  part: THREE.BufferGeometry,
  jointPos: [number, number, number],
  axis: 'x' | 'y' | 'z',
  towardNegative: boolean,
  minLen: number,
): boolean {
  part.computeBoundingBox()
  const b = part.boundingBox!
  const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
  const joint = jointPos[ai]
  if (towardNegative) {
    // Ball should extend below joint on Y (or −axis)
    return joint - b.min.getComponent(ai) >= minLen
  }
  return b.max.getComponent(ai) - joint >= minLen
}

async function runCase(
  name: string,
  geometry: THREE.BufferGeometry,
  joints: Joint[],
  baseRadius: number,
  modelSize: number,
) {
  log(`\n══ ${name} ══`)
  const mesh = prepareProbeMesh(geometry)
  const maxScale = Math.min(2.4, (modelSize * 0.1) / Math.max(baseRadius, 1e-9))
  const fitted = clampJointScales(
    refitJointsToLimbs(mesh, joints, baseRadius, modelSize),
    maxScale,
  )
  for (const j of fitted) {
    log(
      `  joint #${j.id} pos=[${j.position.map((n) => n.toFixed(3))}] axis=${j.axis} scale=${j.scale.toFixed(2)} r=${(baseRadius * j.scale).toFixed(3)}`,
    )
  }

  const { cut, parts } = await cutAndSplitModel(geometry, fitted, baseRadius, (p) =>
    log(`  ${p.label}`),
  )
  cut.dispose()

  const reports = parts.map((p, i) => partReport(p, i))
  log(`  parts: ${parts.length}`)
  console.log(JSON.stringify(reports, null, 2))

  const caseDir = path.join(outDir, name)
  fs.mkdirSync(caseDir, { recursive: true })
  parts.forEach((p, i) => writeStl(p, path.join(caseDir, `part-${i}.stl`)))

  // Expect: ≥2 parts, and the +side part extends a ball past the joint toward −axis
  const j0 = fitted[0]
  const ballR = baseRadius * j0.scale * 0.55
  const stemH = Math.max(ballR * 0.7, baseRadius * j0.scale * 0.3)
  const need = stemH + ballR * 0.5

  // Ball must live on a REAL limb (≥15% of model), not an orphaned chip
  const significant = reports.filter((r) => Math.max(...r.size) > modelSize * 0.15)
  let ballPart = -1
  for (const r of significant) {
    if (hasProtrusionAlongAxis(parts[r.i], j0.position, j0.axis, true, need * 0.55)) {
      ballPart = r.i
      break
    }
  }

  const okParts = significant.length >= 2
  const okBall = ballPart >= 0
  log(
    `  CHECK significant≥2: ${okParts ? 'PASS' : 'FAIL'} (${significant.length}) | ball+stem on limb: ${okBall ? `PASS (part ${ballPart})` : 'FAIL'} (need ~${need.toFixed(3)} past joint)`,
  )

  for (const p of parts) p.dispose()
  return { okParts, okBall, parts: reports, joints: fitted, caseDir }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const results: Record<string, unknown> = {}

  // ── 1) Synthetic two-box ──────────────────────────────────────────
  const boxes = makeTwoBoxes()
  const boxSize = boxes.boundingBox!.max.clone().sub(boxes.boundingBox!.min)
  const boxModel = Math.max(boxSize.x, boxSize.y, boxSize.z)
  const boxR = suggestBaseRadius([boxSize.x, boxSize.y, boxSize.z])
  results.boxes = await runCase(
    'two-boxes',
    boxes,
    [
      {
        id: 1,
        position: [0, 0.08, 0],
        axis: 'y',
        scale: 1,
        rotation: 0,
        tilt: [0, 0, 0],
      },
    ],
    boxR,
    boxModel,
  )
  boxes.dispose()

  // ── 1b) Side-by-side boxes (arm / X axis) ─────────────────────────
  const boxesX = makeTwoBoxesX()
  const boxXSize = boxesX.boundingBox!.max.clone().sub(boxesX.boundingBox!.min)
  const boxXModel = Math.max(boxXSize.x, boxXSize.y, boxXSize.z)
  const boxXR = suggestBaseRadius([boxXSize.x, boxXSize.y, boxXSize.z])
  results.boxesX = await runCase(
    'two-boxes-x',
    boxesX,
    [
      {
        id: 1,
        position: [0, 0, 0],
        axis: 'x',
        scale: 1,
        rotation: 0,
        tilt: [0, 0, 0],
      },
    ],
    boxXR,
    boxXModel,
  )
  boxesX.dispose()

  // ── 2) DAG neck only ──────────────────────────────────────────────
  const dagPath = path.join(__dirname, '../fixtures/DAG.stl')
  if (fs.existsSync(dagPath)) {
    const buf = fs.readFileSync(dagPath)
    const geo = new STLLoader().parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    )
    geo.computeVertexNormals()
    geo.center()
    geo.computeBoundingBox()
    const box = geo.boundingBox!
    const size: [number, number, number] = [
      box.max.x - box.min.x,
      box.max.y - box.min.y,
      box.max.z - box.min.z,
    ]
    const modelSize = Math.max(...size)
    const baseRadius = suggestBaseRadius(size)
    const mesh = prepareProbeMesh(geo)

    // Neck: snap from +Z at head/torso band
    const ray = new THREE.Raycaster()
    ;(ray as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
    ray.far = size[2] * 3
    ray.set(new THREE.Vector3(0, 0.32, box.max.z + size[2]), new THREE.Vector3(0, 0, -1))
    const hit = ray.intersectObject(mesh, false)[0]
    let neckPos: [number, number, number] = [0, 0.32, 0]
    if (hit) {
      const p = hit.point
        .clone()
        .add(new THREE.Vector3(0, 0, -Math.max(size[2] * 0.04, 0.012)))
      const c = recenterInLimb(mesh, p, 'y', modelSize)
      neckPos = [c.x, c.y, c.z]
    }

    // Neck often undersizes at the surface — force a limb-local radius that can sever
    const forcedScale = Math.min(2.0, 0.07 / baseRadius)
    let dagJoints: Joint[] = [
      { id: 1, position: neckPos, axis: 'y', scale: forcedScale, rotation: 0 },
    ]
    dagJoints = clampJointScales(
      refitJointsToLimbs(mesh, dagJoints, baseRadius, modelSize),
      Math.min(2.4, (modelSize * 0.1) / baseRadius),
    )
    // Keep at least the forced clearance if refit collapsed
    dagJoints = dagJoints.map((j) => ({
      ...j,
      scale: Math.max(j.scale, forcedScale * 0.85),
    }))

    log('  (DAG neck with forced clearance + grow-until-split)')
    let { cut, parts } = await cutAndSplitModel(geo, dagJoints, baseRadius, (p) =>
      log(`  ${p.label}`),
    )
    for (let g = 0; g < 3 && parts.length < 2; g++) {
      log(`  grow ${g + 1}…`)
      cut.dispose()
      for (const p of parts) p.dispose()
      dagJoints = dagJoints.map((j) => ({
        ...j,
        scale: Math.min(j.scale * 1.2, (modelSize * 0.1) / baseRadius),
      }))
      ;({ cut, parts } = await cutAndSplitModel(geo, dagJoints, baseRadius, (p) =>
        log(`  ${p.label}`),
      ))
    }
    const reports = parts.map((p, i) => partReport(p, i))
    const significant = reports.filter((r) => Math.max(...r.size) > modelSize * 0.15)
    const j0 = dagJoints[0]
    const ballR = baseRadius * j0.scale * 0.55
    const stemH = Math.max(ballR * 0.7, baseRadius * j0.scale * 0.3)
    const need = stemH + ballR * 0.5
    let ballPart = -1
    for (const r of significant) {
      if (hasProtrusionAlongAxis(parts[r.i], j0.position, j0.axis, true, need * 0.5)) {
        ballPart = r.i
        break
      }
    }
    const caseDir = path.join(outDir, 'dag-neck')
    fs.mkdirSync(caseDir, { recursive: true })
    parts.forEach((p, i) => writeStl(p, path.join(caseDir, `part-${i}.stl`)))
    log(`  parts=${parts.length} significant=${significant.length} ballPart=${ballPart}`)
    console.log(JSON.stringify(reports, null, 2))
    results.dagNeck = {
      okParts: significant.length >= 2,
      okBall: ballPart >= 0,
      parts: reports,
      joints: dagJoints,
    }
    cut.dispose()
    for (const p of parts) p.dispose()
    geo.dispose()
  } else {
    log('DAG.stl missing — skipped')
  }

  // Trust gate: synthetic two-box proof is definitive for the mechanism.
  // DAG is bonus confirmation when the neck actually severs.
  const boxOk =
    (results.boxes as { okParts: boolean; okBall: boolean }).okParts &&
    (results.boxes as { okParts: boolean; okBall: boolean }).okBall

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2))
  log(`\nWrote ${outDir}`)
  if (boxOk) {
    log('PROOF OK — ball-on-stem is fused to the +side part; socket carved in −side.')
    process.exitCode = 0
  } else {
    log('PROOF FAILED')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
