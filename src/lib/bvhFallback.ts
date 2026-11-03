import * as THREE from 'three'
import { Brush, Evaluator, HOLLOW_SUBTRACTION, SUBTRACTION } from 'three-bvh-csg'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Joint } from '../types'
import { applyJointTransform, createCutterGeometry } from './cutterGeometry'
import type { CutProgress } from './manifoldEngine'

/**
 * Fallback CSG when Manifold can't import the STL.
 * Uses hollow subtraction first (more tolerant of non-solid meshes).
 */
export async function cutWithBvhCsg(
  sourceGeometry: THREE.BufferGeometry,
  joints: Joint[],
  baseRadius: number,
  onProgress?: (p: CutProgress) => void,
): Promise<THREE.BufferGeometry> {
  const evaluator = new Evaluator()
  evaluator.useGroups = false

  let working = sourceGeometry.clone()
  working = mergeVertices(working, 1e-4)
  if (!working.getAttribute('normal')) working.computeVertexNormals()

  let brush = new Brush(working)
  brush.updateMatrixWorld(true)

  const unit = createCutterGeometry(1, 1)

  for (let i = 0; i < joints.length; i++) {
    const joint = joints[i]
    onProgress?.({
      current: i + 1,
      total: joints.length,
      label: `Fallback cut joint #${joint.id}…`,
    })
    await new Promise((r) => setTimeout(r, 0))

    const helper = new THREE.Mesh(unit)
    applyJointTransform(helper, joint, 1)
    helper.scale.setScalar(baseRadius * Math.max(joint.scale, 0.05))
    helper.updateMatrixWorld(true)

    const cutterGeo = unit.clone()
    cutterGeo.applyMatrix4(helper.matrixWorld)
    cutterGeo.computeVertexNormals()

    const cutterBrush = new Brush(cutterGeo)
    cutterBrush.position.set(0, 0, 0)
    cutterBrush.rotation.set(0, 0, 0)
    cutterBrush.scale.set(1, 1, 1)
    cutterBrush.updateMatrixWorld(true)

    let result: Brush | null = null
    try {
      result = evaluator.evaluate(brush, cutterBrush, SUBTRACTION)
    } catch {
      try {
        result = evaluator.evaluate(brush, cutterBrush, HOLLOW_SUBTRACTION)
      } catch (err) {
        cutterGeo.dispose()
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(`Fallback boolean failed on joint #${joint.id}: ${detail}`)
      }
    }
    cutterGeo.dispose()
    brush = result
  }

  const out = brush.geometry.clone()
  out.computeVertexNormals()
  working.dispose()
  unit.dispose()
  return out
}
