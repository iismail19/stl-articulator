/**
 * Real-model proof for Dag_natural_happy_3inch.stl
 * Matches the user's articulation screenshot layout:
 *   neck, L/R shoulders, L/R elbows, L/R hips, L/R ankles
 * (small limbs next to torso — arms at sides, short legs/boots).
 *
 *   npm run prove:limbs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { BALL_STEM } from '../src/lib/ballStemProfile.ts'
import {
  clampJointScales,
  prepareProbeMesh,
  recenterInLimb,
  refitJointsToLimbs,
  type ProbeMesh,
} from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import type { CutAxis, Joint } from '../src/types.ts'
import { loadDag3inch } from './dagFixture.mts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '../fixtures/prove-out/dag-limbs')
function log(msg: string) {
  console.log(msg)
}

function writeStl(geo: THREE.BufferGeometry, file: string) {
  const data = new STLExporter().parse(new THREE.Mesh(geo), { binary: true }) as DataView
  fs.writeFileSync(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
}

function partCentroid(g: THREE.BufferGeometry): THREE.Vector3 {
  g.computeBoundingBox()
  const b = g.boundingBox!
  return b.min.clone().add(b.max).multiplyScalar(0.5)
}

function rayHit(
  mesh: ProbeMesh,
  from: THREE.Vector3,
  dir: THREE.Vector3,
  far: number,
): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
  const ray = new THREE.Raycaster()
  ;(ray as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
  ray.far = far
  ray.set(from, dir.clone().normalize())
  const hit = ray.intersectObject(mesh, false)[0]
  if (!hit) return null
  const normal =
    hit.face?.normal.clone().transformDirection(mesh.matrixWorld).normalize() ??
    dir.clone().negate()
  return { point: hit.point.clone(), normal }
}

function placeFromRay(
  mesh: ProbeMesh,
  modelSize: number,
  baseRadius: number,
  id: number,
  from: THREE.Vector3,
  dir: THREE.Vector3,
  axisHint: CutAxis,
  inwardMm: number,
  minScale: number,
): Joint | null {
  const hit = rayHit(mesh, from, dir, modelSize * 3)
  if (!hit) return null
  // Stay near the limb surface — do NOT push into torso center
  const inside = hit.point.clone().addScaledVector(hit.normal, -inwardMm)
  const centered = recenterInLimb(mesh, inside, axisHint, modelSize)
  return {
    id,
    position: [centered.x, centered.y, centered.z],
    axis: axisHint,
    scale: Math.max(minScale, 0.8),
    rotation: 0,
    tilt: [0, 0, 0],
  }
}

function hasBallNearJoint(part: THREE.BufferGeometry, joint: Joint, ballR: number): boolean {
  const pos = part.getAttribute('position') as THREE.BufferAttribute
  const jp = new THREE.Vector3(...joint.position)
  const axis = new THREE.Vector3(
    joint.axis === 'x' ? 1 : 0,
    joint.axis === 'y' ? 1 : 0,
    joint.axis === 'z' ? 1 : 0,
  )
  // Ball may sit on a limb stump offset from the cut; probe several stations
  const offsets = [ballR, ballR * 1.3, ballR * 1.8, ballR * 2.5, ballR * 3.5]
  for (const sign of [-1, 1]) {
    for (const offset of offsets) {
      const ballCenter = jp.clone().addScaledVector(axis, sign * offset)
      const r2 = (ballR * 1.55) ** 2
      let hits = 0
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - ballCenter.x
        const dy = pos.getY(i) - ballCenter.y
        const dz = pos.getZ(i) - ballCenter.z
        if (dx * dx + dy * dy + dz * dz <= r2) hits++
      }
      if (hits >= 25) return true
    }
  }
  return false
}

function hasSocketDepression(part: THREE.BufferGeometry, joint: Joint, ballR: number): boolean {
  const pos = part.getAttribute('position') as THREE.BufferAttribute
  const jp = new THREE.Vector3(...joint.position)
  const n = new THREE.Vector3(
    joint.axis === 'x' ? 1 : 0,
    joint.axis === 'y' ? 1 : 0,
    joint.axis === 'z' ? 1 : 0,
  )
  // Real socket cup: vertices both near the joint AND recessed along ±stem,
  // not just the flat kerf face (which is thin along the normal).
  let minAlong = Infinity
  let maxAlong = -Infinity
  let near = 0
  let deep = 0
  const lateral = ballR * 1.5
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
    const d = v.clone().sub(jp)
    const along = d.dot(n)
    const lat = d.clone().addScaledVector(n, -along).length()
    if (lat > lateral) continue
    near++
    minAlong = Math.min(minAlong, along)
    maxAlong = Math.max(maxAlong, along)
    if (Math.abs(along) > ballR * 0.35 && lat < ballR * 0.95) deep++
  }
  if (near < 16 || deep < 5) return false
  return maxAlong - minAlong >= ballR * 0.45
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const { geo, source } = loadDag3inch()
  log(`Loading ${source}`)
  // Full mesh — Manifold.simplify inside the cut path handles density
  const tris = (geo.getIndex()?.count ?? geo.getAttribute('position').count) / 3
  log(`tris=${tris}`)
  const box = geo.boundingBox!
  const size = box.max.clone().sub(box.min)
  const modelSize = Math.max(size.x, size.y, size.z)
  const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
  log(`size=${[...size].map((n) => n.toFixed(2))} baseR=${baseRadius.toFixed(4)}`)

  const mesh = prepareProbeMesh(geo)
  const sx = size.x
  const sy = size.y
  const sz = size.z

  // Neck under head block (screenshot: ball on head, socket on torso)
  const neckZ = sz * 0.34
  const neckJoint: Joint = {
    id: 1,
    position: [0, 0, neckZ],
    axis: 'z',
    scale: 2.2,
    rotation: 0,
    tilt: [0, 0, 0],
  }
  {
    const centered = recenterInLimb(
      mesh,
      new THREE.Vector3(0, 0, neckZ),
      'z',
      modelSize * 1.4,
    )
    neckJoint.position = [centered.x, centered.y, centered.z]
  }

  // Screenshot layout: neck · shoulders · elbows · hips · ankles
  const raw: (Joint | null)[] = [
    neckJoint,
    // Shoulders (armpits / side of torso cube)
    placeFromRay(
      mesh,
      modelSize,
      baseRadius,
      2,
      new THREE.Vector3(-sx, sy * 0.05, sz * 0.15),
      new THREE.Vector3(1, 0, 0),
      'x',
      2.5,
      2.5,
    ),
    placeFromRay(
      mesh,
      modelSize,
      baseRadius,
      3,
      new THREE.Vector3(sx, sy * 0.05, sz * 0.15),
      new THREE.Vector3(-1, 0, 0),
      'x',
      2.5,
      2.5,
    ),
    // Elbows (mid-upper-arm — keep clear of forearm/hand)
    placeFromRay(
      mesh,
      modelSize,
      baseRadius,
      4,
      new THREE.Vector3(-sx, 0, sz * 0.06),
      new THREE.Vector3(1, 0, 0),
      'x',
      2,
      1.4,
    ),
    placeFromRay(
      mesh,
      modelSize,
      baseRadius,
      5,
      new THREE.Vector3(sx, 0, sz * 0.06),
      new THREE.Vector3(-1, 0, 0),
      'x',
      2,
      1.4,
    ),
    // Hips — front rays into thigh roots under the torso block
    placeFromRay(
      mesh,
      modelSize,
      baseRadius,
      6,
      new THREE.Vector3(-sx * 0.22, sy, -sz * 0.18),
      new THREE.Vector3(0, -1, 0),
      'z',
      2.5,
      1.8,
    ),
    placeFromRay(
      mesh,
      modelSize,
      baseRadius,
      7,
      new THREE.Vector3(sx * 0.22, sy, -sz * 0.18),
      new THREE.Vector3(0, -1, 0),
      'z',
      2.5,
      1.8,
    ),
    // Ankles — front rays into boot tops (short limbs side-by-side)
    placeFromRay(
      mesh,
      modelSize,
      baseRadius,
      8,
      new THREE.Vector3(-sx * 0.28, sy, -sz * 0.38),
      new THREE.Vector3(0, -1, 0),
      'z',
      2,
      1.1,
    ),
    placeFromRay(
      mesh,
      modelSize,
      baseRadius,
      9,
      new THREE.Vector3(sx * 0.28, sy, -sz * 0.38),
      new THREE.Vector3(0, -1, 0),
      'z',
      2,
      1.1,
    ),
  ]

  let joints = raw.filter((j): j is Joint => j != null)
  log(`Placed ${joints.length}/9 probe joints (neck/shoulders/elbows/hips/ankles)`)
  for (const j of joints) {
    log(
      `  #${j.id} ${j.axis} pos=[${j.position.map((n) => n.toFixed(3))}] scale=${j.scale.toFixed(2)}`,
    )
  }
  if (joints.length < 5) {
    log('FAIL — could not place enough joints')
    process.exit(1)
  }

  const maxScale = Math.min(3.2, (modelSize * 0.16) / baseRadius)
  joints = clampJointScales(refitJointsToLimbs(mesh, joints, baseRadius, modelSize), maxScale)
  // Shoulders need ~scale 3 for armpit blend; hips a bit large too
  joints = joints.map((j) => {
    if (j.id === 2 || j.id === 3) return { ...j, scale: Math.max(j.scale, 2.5) }
    if (j.id === 6 || j.id === 7) return { ...j, scale: Math.max(j.scale, 1.8) }
    if (j.id === 1) return { ...j, scale: Math.max(j.scale, 2.2) }
    if (j.id === 8 || j.id === 9) return { ...j, scale: Math.max(j.scale, 1.0) }
    return { ...j, scale: Math.max(j.scale, 1.2) }
  })
  joints = clampJointScales(joints, maxScale)

  log('\nCutting (grow until enough parts)…')
  let { cut, parts } = await cutAndSplitModel(geo, joints, baseRadius, (p) => log(`  ${p.label}`), 'pla')
  const wantParts = Math.min(joints.length + 1, 8)
  for (let g = 0; g < 3 && parts.length < wantParts; g++) {
    log(`  parts=${parts.length} < ${wantParts} — grow scales ${g + 1}`)
    cut.dispose()
    for (const p of parts) p.dispose()
    joints = joints.map((j) => ({
      ...j,
      scale: Math.min(j.scale * 1.15, maxScale),
    }))
    ;({ cut, parts } = await cutAndSplitModel(geo, joints, baseRadius, (p) => log(`  ${p.label}`), 'pla'))
  }
  cut.dispose()
  log(`Parts: ${parts.length}`)
  parts.forEach((p, i) => writeStl(p, path.join(outDir, `part-${i}.stl`)))

  type JR = {
    id: number
    axis: string
    ballPart: number
    socketPart: number
    okBall: boolean
    okSocket: boolean
  }
  const jointResults: JR[] = []
  let fails = 0

  for (const j of joints) {
    const ballR = baseRadius * j.scale * BALL_STEM.ballOfR
    const jp = new THREE.Vector3(...j.position)
    const near = parts
      .map((p, i) => ({ i, d: partCentroid(p).distanceTo(jp) }))
      .filter((x) => x.d < modelSize * 0.5)
      .sort((a, b) => a.d - b.d)

    let ballPart = -1
    let socketPart = -1
    for (const n of near) {
      if (ballPart < 0 && hasBallNearJoint(parts[n.i], j, ballR)) ballPart = n.i
    }
    for (const n of near) {
      if (n.i === ballPart) continue
      if (socketPart < 0 && hasSocketDepression(parts[n.i], j, ballR)) socketPart = n.i
    }

    const okBall = ballPart >= 0
    const okSocket = socketPart >= 0
    if (!okBall || !okSocket) fails++
    jointResults.push({ id: j.id, axis: j.axis, ballPart, socketPart, okBall, okSocket })
    log(
      `  Joint #${j.id} (${j.axis}): ball=${okBall ? `part ${ballPart}` : 'FAIL'} socket=${okSocket ? `part ${socketPart}` : 'FAIL'} near=${near.length}`,
    )
  }

  const ballHosts = jointResults.map((r) => r.ballPart).filter((i) => i >= 0)
  const uniqueBallHosts = new Set(ballHosts).size
  const okSpread = uniqueBallHosts >= Math.min(3, Math.max(1, ballHosts.length))
  if (!okSpread) {
    fails++
    log(`  FAIL ball-host spread: ${uniqueBallHosts} unique host(s)`)
  } else {
    log(`  ball-host spread OK (${uniqueBallHosts})`)
  }

  const okParts = parts.length >= 6
  if (!okParts) {
    fails++
    log(`  FAIL part count ${parts.length} (want ≥6 for full limb set)`)
  }

  fs.writeFileSync(
    path.join(outDir, 'report.json'),
    JSON.stringify(
      {
        stl: source,
        tris,
        size: [...size],
        partCount: parts.length,
        joints: jointResults,
        scales: joints.map((j) => ({ id: j.id, scale: j.scale })),
        fails,
      },
      null,
      2,
    ),
  )
  log(`\nWrote ${outDir}`)
  for (const p of parts) p.dispose()
  geo.dispose()

  if (fails === 0) {
    log('DAG LIMBS PROOF OK')
    process.exitCode = 0
  } else {
    log(`DAG LIMBS PROOF FAILED (${fails} checks)`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
