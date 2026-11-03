/**
 * Strict proof for Dag arms+neck (NO legs) — flipped neck frees torso for arms:
 *
 *   Torso ──ball──▶ socket in head (neck)     ← flipped: torso keeps shoulder room
 *   Upper arm ──ball──▶ socket in torso (shoulder)
 *   Upper arm ──ball──▶ socket in forearm/hand (elbow)
 *
 *   npm run prove:visual
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { BALL_STEM, computeBallStemDims } from '../src/lib/ballStemProfile.ts'
import {
  getFilamentProfile,
  PLA_VALIDATED,
  socketRadialDims,
} from '../src/lib/filamentProfiles.ts'
import {
  clampJointScales,
  prepareProbeMesh,
  recenterInLimb,
  refitJointsToLimbs,
} from '../src/lib/meshProbe.ts'
import type { JointSeatRecord } from '../src/lib/manifoldEngine.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import type { Joint } from '../src/types.ts'
import { loadDag3inch } from './dagFixture.mts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '../fixtures/prove-out/visual')
type Meta = {
  i: number
  b: THREE.Box3
  size: THREE.Vector3
  center: THREE.Vector3
  vol: number
  tris: number
}

function log(ok: boolean, msg: string) {
  console.log(ok ? 'OK  ' : 'FAIL', msg)
  return ok
}

function partMeta(g: THREE.BufferGeometry, i: number): Meta {
  g.computeBoundingBox()
  const b = g.boundingBox!
  const size = b.max.clone().sub(b.min)
  const center = b.min.clone().add(b.max).multiplyScalar(0.5)
  const index = g.getIndex()
  const tris = index ? index.count / 3 : g.getAttribute('position').count / 3
  return { i, b, size, center, vol: size.x * size.y * size.z, tris }
}

/** Sample verts in a sphere; return count. */
function countInSphere(
  g: THREE.BufferGeometry,
  center: THREE.Vector3,
  radius: number,
): number {
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const r2 = radius * radius
  let n = 0
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - center.x
    const dy = pos.getY(i) - center.y
    const dz = pos.getZ(i) - center.z
    if (dx * dx + dy * dy + dz * dz <= r2) n++
  }
  return n
}

/** How far the bbox extends past `origin` along `dir` (positive = protrudes that way). */
function extentAlong(
  b: THREE.Box3,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
): number {
  const n = dir.clone().normalize()
  const corners = [
    new THREE.Vector3(b.min.x, b.min.y, b.min.z),
    new THREE.Vector3(b.min.x, b.min.y, b.max.z),
    new THREE.Vector3(b.min.x, b.max.y, b.min.z),
    new THREE.Vector3(b.min.x, b.max.y, b.max.z),
    new THREE.Vector3(b.max.x, b.min.y, b.min.z),
    new THREE.Vector3(b.max.x, b.min.y, b.max.z),
    new THREE.Vector3(b.max.x, b.max.y, b.min.z),
    new THREE.Vector3(b.max.x, b.max.y, b.max.z),
  ]
  let maxA = -Infinity
  for (const c of corners) maxA = Math.max(maxA, n.dot(c.clone().sub(origin)))
  return maxA
}

/**
 * Ball on a part: dense sphere of verts OUTSIDE the cut face toward `outDir`,
 * and the part bbox must extend past the joint along outDir.
 */
function hasExteriorBall(
  g: THREE.BufferGeometry,
  joint: Joint,
  outDir: THREE.Vector3,
  ballR: number,
): { ok: boolean; detail: string } {
  const meta = partMeta(g, -1)
  const jp = new THREE.Vector3(...joint.position)
  const n = outDir.clone().normalize()
  // Tip of ball sits past the cut toward the mating part
  const tip = jp.clone().addScaledVector(n, ballR * 1.15)
  const hits = countInSphere(g, tip, ballR * 1.25)
  const extent = extentAlong(meta.b, jp, n)
  const ok = hits >= 50 && extent >= ballR * 0.55
  return {
    ok,
    detail: `hits=${hits} extent=${extent.toFixed(2)} need≥${(ballR * 0.55).toFixed(2)}`,
  }
}

/**
 * Real socket cup: recessed verts along ±axis with lateral cluster,
 * AND a hollow core (few verts at joint center — not a filled stump).
 * Kerf flats fail the hollow + depth checks.
 */
function hasRealSocket(
  g: THREE.BufferGeometry,
  joint: Joint,
  axis: THREE.Vector3,
  ballR: number,
): { ok: boolean; detail: string } {
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const jp = new THREE.Vector3(...joint.position)
  const n = axis.clone().normalize()
  let near = 0
  let deep = 0
  let minA = Infinity
  let maxA = -Infinity
  const coreR = ballR * 0.35
  const coreHits = countInSphere(g, jp, coreR)

  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
    const d = v.clone().sub(jp)
    const along = d.dot(n)
    const lat = d.clone().addScaledVector(n, -along).length()
    if (lat > ballR * 1.25) continue
    near++
    minA = Math.min(minA, along)
    maxA = Math.max(maxA, along)
    // Cup wall: recessed along axis, not on the flat rim only
    if (Math.abs(along) > ballR * 0.4 && lat < ballR * 0.85) deep++
  }
  const span = maxA - minA
  // Hollow: core of the cup should be emptier than a solid face
  const hollow = coreHits < 25
  // deep≥10: real cup walls (kerf flats have deep≈0). Head cups can be shallower
  // than torso armpit cups but still retain the ball.
  const ok = near >= 30 && deep >= 10 && span >= ballR * 0.55 && hollow
  return {
    ok,
    detail: `near=${near} deep=${deep} span=${span.toFixed(2)} core=${coreHits} hollow=${hollow}`,
  }
}

/** Verts lying on a sphere shell around `c` (Manifold sphere verts sit exactly on radius). */
function countOnShell(g: THREE.BufferGeometry, c: THREE.Vector3, r: number, tol = 0.015) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const lo = (r * (1 - tol)) ** 2
  const hi = (r * (1 + tol)) ** 2
  let n = 0
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - c.x
    const dy = pos.getY(i) - c.y
    const dz = pos.getZ(i) - c.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 >= lo && d2 <= hi) n++
  }
  return n
}

/**
 * Seat-level proof: one part carries the ball sphere (ballR) at the seat,
 * a DIFFERENT part carries the cup wall (socketR), and nothing of the cup
 * host sits inside the ball volume.
 */
function checkSeat(parts: THREE.BufferGeometry[], seat: JointSeatRecord) {
  const c = new THREE.Vector3(...seat.center)
  const ballHitsAll = parts.map((g) => countOnShell(g, c, seat.ballR))
  const ballPart = ballHitsAll.indexOf(Math.max(...ballHitsAll))
  const sockHitsAll = parts.map((g, i) => (i === ballPart ? -1 : countOnShell(g, c, seat.socketR)))
  const sockPart = sockHitsAll.indexOf(Math.max(...sockHitsAll))
  return {
    ballPart,
    sockPart,
    ballHits: ballHitsAll[ballPart],
    sockHits: sockHitsAll[sockPart],
    filled: countInSphere(parts[sockPart], c, seat.ballR * 0.9),
  }
}

function writeStl(geo: THREE.BufferGeometry, file: string) {
  const data = new STLExporter().parse(new THREE.Mesh(geo), { binary: true }) as DataView
  fs.writeFileSync(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
}

async function runCut(
  geo: THREE.BufferGeometry,
  joints: Joint[],
  baseRadius: number,
  label: string,
) {
  console.log(`\n── ${label} ──`)
  for (const j of joints) {
    console.log(
      `  #${j.id} ${j.axis}`,
      j.position.map((n) => +n.toFixed(2)),
      's',
      j.scale.toFixed(2),
    )
  }
  const { parts, cut } = await cutAndSplitModel(
    geo,
    joints,
    baseRadius,
    (p) => {
      if (
        p.label.includes('Sever') ||
        p.label.includes('Simplif') ||
        p.label.includes('Finding') ||
        p.label.includes('Adding')
      )
        console.log(' ', p.label)
    },
    'pla',
  )
  cut.dispose()
  return parts
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  // ── Tolerance lock (same as test square) ──────────────────────────
  const pla = getFilamentProfile('pla')
  let fails = 0
  const tolChecks: [string, boolean][] = [
    ['PLA clearance 1.05', pla.socketClearance === PLA_VALIDATED.socketClearance],
    ['PLA mouth 0.955', pla.mouthRatio === PLA_VALIDATED.mouthRatio],
    ['PLA flexSlots 4', pla.flexSlots === PLA_VALIDATED.flexSlots],
    ['ballOfR 0.4', BALL_STEM.ballOfR === 0.4],
    ['stemOfBall 0.52', BALL_STEM.stemOfBall === 0.52],
  ]
  for (const [name, ok] of tolChecks) {
    if (!log(ok, `tol ${name}`)) fails++
  }
  {
    const ballR = 4
    const dims = computeBallStemDims(ballR / BALL_STEM.ballOfR)
    const { socketR, mouthR } = socketRadialDims(ballR, pla)
    if (!log(Math.abs(dims.ballR - 4) < 1e-6, 'Ø8 test ball from profile')) fails++
    if (!log(Math.abs(socketR / ballR - 1.05) < 1e-9, 'socketR/ballR=1.05')) fails++
    if (!log(Math.abs(mouthR / ballR - 0.955) < 1e-9, 'mouthR/ballR=0.955')) fails++
  }

  const { geo } = loadDag3inch()
  const box = geo.boundingBox!
  const size = box.max.clone().sub(box.min)
  const modelSize = Math.max(size.x, size.y, size.z)
  const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
  const mesh = prepareProbeMesh(geo)
  const sx = size.x
  const sz = size.z
  const maxScale = Math.min(3.2, (modelSize * 0.16) / baseRadius)

  const neckC = recenterInLimb(mesh, new THREE.Vector3(0, 0, sz * 0.34), 'z', modelSize)
  const neck: Joint = {
    id: 1,
    position: [neckC.x, neckC.y, neckC.z],
    axis: 'z',
    scale: 2.2,
    rotation: 0,
    tilt: [0, 0, 0],
  }

  // Neck + the user's saved Dag arm layout (left), mirrored for the right arm.
  // Shoulder = X cut twisted 180° + 9° tilt; elbow = Z cut tilted 22°.
  const userArm: Joint[] = [
    {
      id: 2,
      position: [-9.605, 0.488, 1.125],
      axis: 'x',
      scale: 1.3,
      rotation: 180,
      tilt: [0, 9, 0],
    },
    {
      id: 3,
      position: [-15.749, -0.396, -6.128],
      axis: 'z',
      scale: 0.72,
      rotation: 0,
      tilt: [0, 22, 0],
    },
  ]
  // Dag isn't symmetric: recenter the mirrored shoulder in the right limb, then
  // hang the right elbow off it with the left arm's shoulder→elbow offset.
  const rShoulder = recenterInLimb(
    mesh,
    new THREE.Vector3(-userArm[0].position[0], userArm[0].position[1], userArm[0].position[2]),
    'x',
    modelSize,
  )
  const mirrored: Joint[] = userArm.map((j, i) => {
    const off = new THREE.Vector3(...j.position).sub(new THREE.Vector3(...userArm[0].position))
    const c =
      i === 0
        ? rShoulder
        : recenterInLimb(
            mesh,
            rShoulder.clone().add(new THREE.Vector3(-off.x, off.y, off.z)),
            j.axis,
            modelSize,
          )
    return {
      ...j,
      id: 4 + i,
      position: [c.x, c.y, c.z],
      rotation: j.axis === 'x' ? (j.rotation + 180) % 360 : j.rotation,
      tilt: [j.tilt[0], -j.tilt[1], -j.tilt[2]],
    }
  })
  const armJoints = [
    neck,
    ...clampJointScales(
      refitJointsToLimbs(mesh, [...userArm, ...mirrored], baseRadius, modelSize),
      maxScale,
    ),
  ]

  // ── A) Neck only: ball on torso (up), socket in head ─
  {
    const parts = await runCut(geo, [neck], baseRadius, 'A neck only')
    parts.forEach((p, i) => writeStl(p, path.join(outDir, `A-part-${i}.stl`)))
    const metas = parts.map((p, i) => partMeta(p, i))
    const torso = [...metas].sort((a, b) => b.vol - a.vol)[0]
    const head = [...metas]
      .filter((m) => m.i !== torso.i)
      .filter((m) => Math.abs(m.center.x) < sx * 0.3 && m.center.z > sz * 0.15)
      .sort((a, b) => b.vol - a.vol)[0]

    const splitOk = log(
      parts.length >= 2 && !!head && torso.b.max.z < size.z * 0.45,
      `neck split parts=${parts.length} torsoMaxZ=${torso.b.max.z.toFixed(1)} head=${head?.i ?? 'none'}`,
    )
    if (!splitOk) fails++

    const ballR = baseRadius * neck.scale * BALL_STEM.ballOfR
    const ball = hasExteriorBall(parts[torso.i], neck, new THREE.Vector3(0, 0, 1), ballR)
    if (!log(ball.ok, `neck: ball ON TORSO (${ball.detail})`)) fails++

    if (head) {
      const sock = hasRealSocket(parts[head.i], neck, new THREE.Vector3(0, 0, -1), ballR)
      if (!log(sock.ok, `neck: socket IN HEAD (${sock.detail})`)) fails++
      const headIsBall = hasExteriorBall(parts[head.i], neck, new THREE.Vector3(0, 0, -1), ballR)
      if (!log(!headIsBall.ok, `neck: head is NOT the ball host (${headIsBall.detail})`))
        fails++
    } else {
      fails++
      log(false, 'neck: no head part')
    }

    for (const p of parts) p.dispose()
  }

  // ── B) Neck + both arms (user layout) — every seat must be a real ball in a real cup ─
  {
    const dbg = globalThis as { __ARTIC_DEBUG?: boolean; __ARTIC_SEATS?: JointSeatRecord[] }
    dbg.__ARTIC_DEBUG = true
    dbg.__ARTIC_SEATS = []
    const parts = await runCut(geo, armJoints, baseRadius, 'B neck + arms (user layout)')
    dbg.__ARTIC_DEBUG = false
    const seats = dbg.__ARTIC_SEATS ?? []
    parts.forEach((p, i) => writeStl(p, path.join(outDir, `B-part-${i}.stl`)))
    const metas = parts.map((p, i) => partMeta(p, i))
    const torso = [...metas].sort((a, b) => b.vol - a.vol)[0]

    console.log('  parts:')
    for (const m of [...metas].sort((a, b) => b.vol - a.vol)) {
      console.log(
        `    #${m.i} vol=${m.vol.toFixed(0)} c=(${m.center.x.toFixed(1)},${m.center.y.toFixed(1)},${m.center.z.toFixed(1)})`,
      )
    }
    if (!log(parts.length >= 6, `part count ${parts.length} (torso, head, 2 upper arms, 2 forearms)`))
      fails++

    const upperArmOf = new Map<number, number>()
    for (const joint of armJoints) {
      const tag =
        joint.id === 1
          ? 'neck'
          : `${joint.position[0] < 0 ? 'L' : 'R'} ${joint.axis === 'x' ? 'shoulder' : 'elbow'}`
      const seat = seats.find((s) => s.jointId === joint.id)
      if (!seat) {
        fails++
        log(false, `B ${tag}: no ball/socket seated`)
        continue
      }
      const r = checkSeat(parts, seat)
      const jR = baseRadius * joint.scale
      const drift = new THREE.Vector3(...seat.center).distanceTo(new THREE.Vector3(...joint.position))
      const ballM = metas[r.ballPart]
      const sockM = metas[r.sockPart]
      const base = `ball=part${r.ballPart}(${r.ballHits}) socket=part${r.sockPart}(${r.sockHits}) filled=${r.filled} drift=${drift.toFixed(2)}`

      if (!log(r.ballHits >= 60, `B ${tag}: visible ball sphere on a part (${base})`)) fails++
      if (!log(r.sockHits >= 40 && r.filled === 0, `B ${tag}: open cup around the ball (${base})`))
        fails++
      if (!log(drift <= jR * 1.5, `B ${tag}: seat stays near the marker (≤${(jR * 1.5).toFixed(2)})`))
        fails++

      let roleOk = false
      if (joint.id === 1) {
        roleOk = r.ballPart === torso.i && sockM.center.z > ballM.center.z
      } else if (joint.axis === 'x') {
        roleOk = r.sockPart === torso.i && r.ballPart !== torso.i
        if (roleOk) upperArmOf.set(Math.sign(joint.position[0]), r.ballPart)
      } else {
        const upper = upperArmOf.get(Math.sign(joint.position[0]))
        roleOk =
          r.ballPart === upper && r.sockPart !== torso.i && sockM.center.z < ballM.center.z
      }
      const want =
        joint.id === 1
          ? 'ball on torso, socket in head'
          : joint.axis === 'x'
            ? 'socket in torso, ball on upper arm'
            : 'ball on upper arm, socket in forearm'
      if (!log(roleOk, `B ${tag}: ${want}`)) fails++
    }

    const report = {
      fails,
      partCount: parts.length,
      seats,
      parts: metas.map((m) => ({
        i: m.i,
        vol: +m.vol.toFixed(1),
        center: m.center.toArray().map((n) => +n.toFixed(2)),
      })),
      joints: armJoints,
      pla: PLA_VALIDATED,
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
    for (const p of parts) p.dispose()
  }

  geo.dispose()
  console.log(`\nWrote ${outDir}`)
  if (fails === 0) {
    console.log('VISUAL JOINT PROOF OK (arms+neck, strict)')
    process.exitCode = 0
  } else {
    console.log(`VISUAL JOINT PROOF FAILED (${fails} checks)`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
