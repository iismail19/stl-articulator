/**
 * Assert app cut tolerances === PLA test-square values we printed and agreed on.
 *
 *   npx tsx scripts/prove-tolerance.mts
 */
import * as THREE from 'three'
import { BALL_STEM, computeBallStemDims } from '../src/lib/ballStemProfile.ts'
import { jointCutNormal, jointLocalToWorld } from '../src/lib/cutterGeometry.ts'
import {
  getFilamentProfile,
  PLA_VALIDATED,
  socketRadialDims,
} from '../src/lib/filamentProfiles.ts'

let fails = 0
function check(name: string, got: number, want: number, eps = 1e-9) {
  if (Math.abs(got - want) > eps) {
    console.error(`FAIL ${name}: got ${got}, want ${want}`)
    fails++
  } else {
    console.log(`OK   ${name} = ${got}`)
  }
}

const pla = getFilamentProfile('pla')
const plaPlus = getFilamentProfile('pla_plus')
check('PLA socketClearance', pla.socketClearance, PLA_VALIDATED.socketClearance)
check('PLA mouthRatio', pla.mouthRatio, PLA_VALIDATED.mouthRatio)
check('PLA flexSlots', pla.flexSlots, PLA_VALIDATED.flexSlots)
check('PLA+ socketClearance', plaPlus.socketClearance, pla.socketClearance)
check('PLA+ mouthRatio', plaPlus.mouthRatio, pla.mouthRatio)
check('PLA+ flexSlots', plaPlus.flexSlots, pla.flexSlots)
check('PLA+ maxGapMm', plaPlus.maxGapMm ?? -1, pla.maxGapMm ?? -1)

// Ø8 mm test ball — same as gen-pla-test-joint
const ballR = 4
const r = ballR / BALL_STEM.ballOfR
const dims = computeBallStemDims(r)
check('test ballR from profile', dims.ballR, ballR, 1e-6)
check('stemOfBall', dims.stemR / dims.ballR, BALL_STEM.stemOfBall, 1e-6)

const { socketR, mouthR } = socketRadialDims(ballR, pla)
check('socketR / ballR', socketR / ballR, 1.05, 1e-9)
check('mouthR / ballR', mouthR / ballR, 0.955, 1e-9)

// Strength floors from print feedback
check('stem thicker than 0.5·ball', dims.stemR >= ballR * 0.5 ? 1 : 0, 1)
check('ballOfR', BALL_STEM.ballOfR, 0.4)

// Preview marker stem (Three) must equal the cut stem (Manifold local +Z)
{
  let worst = 0
  for (const axis of ['x', 'y', 'z'] as const) {
    for (const rotation of [0, 45, 90, 180, 270]) {
      for (const tilt of [[0, 0, 0], [0, 20, 0], [15, 20, -10]] as [number, number, number][]) {
        const j = { id: 1, position: [3, -2, 5] as [number, number, number], axis, scale: 1, rotation, tilt }
        const m = jointLocalToWorld(j)
        const tip = new THREE.Vector3(0, 0, 1).applyMatrix4(m).sub(new THREE.Vector3(...j.position))
        worst = Math.max(worst, tip.distanceTo(jointCutNormal(j)))
      }
    }
  }
  check('preview stem vs cut stem (max error)', worst, 0, 1e-6)
}

if (fails === 0) {
  console.log('\nTOLERANCE PROOF OK — app matches PLA test square')
  process.exitCode = 0
} else {
  console.log(`\nTOLERANCE PROOF FAILED (${fails})`)
  process.exitCode = 1
}
