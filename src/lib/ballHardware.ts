import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Joint } from '../types'
import {
  BALL_STEM,
  computeBallStemDims,
  midStemPlacement,
} from './ballStemProfile'
import { jointStemQuaternion } from './cutterGeometry'

function jointWorldRadius(baseRadius: number, joint: Joint): number {
  return Math.max(baseRadius * Math.max(joint.scale, 0.05), 1e-6)
}

/**
 * Printable ball + stem you can snap into a socket cavity.
 * Matches manifoldEngine / ballStemProfile exactly.
 */
export function createBallHardwareGeometry(
  baseRadius: number,
  joint: Joint,
): THREE.BufferGeometry {
  const dims = computeBallStemDims(jointWorldRadius(baseRadius, joint))
  const {
    ballR,
    stemR,
    stemH,
    ballChamferH,
    ballChamferWide,
    ballChamferNarrow,
    collarH,
    stepH,
  } = dims
  const P = BALL_STEM
  const mid = midStemPlacement(dims)

  // Y-up preview matching manifoldEngine local Z (ball at -stemH)
  const ball = new THREE.SphereGeometry(ballR, 32, 24)
  ball.translate(0, -stemH, 0)

  const ballChamfer = new THREE.CylinderGeometry(
    ballChamferNarrow,
    ballChamferWide,
    ballChamferH,
    28,
  )
  const chamferY0 = -stemH + ballR * P.ballChamferStartOfBall
  ballChamfer.translate(0, chamferY0 + ballChamferH / 2, 0)

  const stemMesh = new THREE.CylinderGeometry(stemR, stemR, mid.len, 24)
  stemMesh.translate(0, mid.z0 + mid.len / 2, 0)

  // Wide toward body (+Y), narrow toward ball (−Y) — matches manifoldEngine
  const collar = new THREE.CylinderGeometry(
    stemR * P.collarWideOfStem,
    stemR * P.collarNarrowOfStem,
    collarH,
    28,
  )
  collar.translate(0, collarH * 0.38, 0)

  const step = new THREE.CylinderGeometry(
    stemR * P.stepWideOfStem,
    stemR * P.stepNarrowOfStem,
    stepH,
    24,
  )
  step.translate(0, stepH * 0.15, 0)

  const merged = mergeGeometries([ball, ballChamfer, stemMesh, collar, step], false)
  ball.dispose()
  ballChamfer.dispose()
  stemMesh.dispose()
  collar.dispose()
  step.dispose()
  const geo = merged ?? new THREE.SphereGeometry(ballR, 32, 24)

  geo.applyQuaternion(jointStemQuaternion(joint))
  geo.computeVertexNormals()
  return geo
}
