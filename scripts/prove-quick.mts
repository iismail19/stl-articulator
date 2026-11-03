/**
 * Fast smoke for the neck-flip + PLA lock (no full arm suite).
 *
 *   npm run prove:quick
 */
import * as THREE from 'three'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { BALL_STEM } from '../src/lib/ballStemProfile.ts'
import {
  getFilamentProfile,
  PLA_VALIDATED,
  socketRadialDims,
} from '../src/lib/filamentProfiles.ts'
import { recenterInLimb, prepareProbeMesh } from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import type { Joint } from '../src/types.ts'
import { loadDag3inch } from './dagFixture.mts'

function log(ok: boolean, msg: string) {
  console.log(ok ? 'OK  ' : 'FAIL', msg)
  return ok
}

function countInSphere(g: THREE.BufferGeometry, c: THREE.Vector3, r: number) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const r2 = r * r
  let n = 0
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - c.x
    const dy = pos.getY(i) - c.y
    const dz = pos.getZ(i) - c.z
    if (dx * dx + dy * dy + dz * dz <= r2) n++
  }
  return n
}

async function main() {
  let fails = 0
  const pla = getFilamentProfile('pla')
  if (!log(pla.socketClearance === PLA_VALIDATED.socketClearance, 'PLA clearance')) fails++
  if (!log(pla.mouthRatio === PLA_VALIDATED.mouthRatio, 'PLA mouth')) fails++
  const { socketR, mouthR } = socketRadialDims(4, pla)
  if (!log(Math.abs(socketR / 4 - 1.05) < 1e-9, 'socketR/ballR')) fails++
  if (!log(Math.abs(mouthR / 4 - 0.955) < 1e-9, 'mouthR/ballR')) fails++

  const { geo } = loadDag3inch()
  const box = geo.boundingBox!
  const size = box.max.clone().sub(box.min)
  const modelSize = Math.max(size.x, size.y, size.z)
  const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
  const mesh = prepareProbeMesh(geo)
  const neckC = recenterInLimb(mesh, new THREE.Vector3(0, 0, size.z * 0.34), 'z', modelSize)
  const neck: Joint = {
    id: 1,
    position: [neckC.x, neckC.y, neckC.z],
    axis: 'z',
    scale: 2.2,
    rotation: 0,
    tilt: [0, 0, 0],
  }

  console.log('Cutting neck only…')
  const { parts } = await cutAndSplitModel(geo, [neck], baseRadius, undefined, 'pla')
  const metas = parts.map((p, i) => {
    p.computeBoundingBox()
    const b = p.boundingBox!
    const s = b.max.clone().sub(b.min)
    const c = b.min.clone().add(b.max).multiplyScalar(0.5)
    return { i, vol: s.x * s.y * s.z, c, b }
  })
  const torso = [...metas].sort((a, b) => b.vol - a.vol)[0]
  const head = [...metas]
    .filter((m) => m.i !== torso.i)
    .filter((m) => m.c.z > size.z * 0.15)
    .sort((a, b) => b.vol - a.vol)[0]

  if (!log(parts.length >= 2 && !!head, `split parts=${parts.length} head=${head?.i ?? 'none'}`))
    fails++

  const ballR = baseRadius * neck.scale * BALL_STEM.ballOfR
  const tip = new THREE.Vector3(...neck.position).add(new THREE.Vector3(0, 0, ballR * 1.15))
  const torsoHits = countInSphere(parts[torso.i], tip, ballR * 1.25)
  if (!log(torsoHits >= 40, `neck ball ON TORSO (hits=${torsoHits})`)) fails++

  if (head) {
    const core = countInSphere(
      parts[head.i],
      new THREE.Vector3(...neck.position),
      ballR * 0.35,
    )
    if (!log(core < 25, `neck socket IN HEAD (core=${core} hollow)`)) fails++
    const headTip = new THREE.Vector3(...neck.position).add(
      new THREE.Vector3(0, 0, -ballR * 1.15),
    )
    const headBall = countInSphere(parts[head.i], headTip, ballR * 1.25)
    if (!log(headBall < 40, `head is NOT ball host (hits=${headBall})`)) fails++
  }

  for (const p of parts) p.dispose()
  geo.dispose()

  if (fails === 0) {
    console.log('\nQUICK PROOF OK — PLA + flipped neck')
    process.exitCode = 0
  } else {
    console.log(`\nQUICK PROOF FAILED (${fails})`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
