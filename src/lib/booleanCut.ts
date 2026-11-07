import * as THREE from 'three'
import type { Joint } from '../types'
import {
  DEFAULT_FILAMENT,
  type FilamentType,
} from './filamentProfiles'
import { cutWithManifold, type CutProgress, type CutResult } from './manifoldEngine'
import { splitConnectedComponents } from './splitMesh'

export type { CutProgress, CutResult, FilamentType }
export { splitConnectedComponents, DEFAULT_FILAMENT }

export async function cutJointsFromModel(
  sourceGeometry: THREE.BufferGeometry,
  joints: Joint[],
  baseRadius: number,
  onProgress?: (p: CutProgress) => void,
  filamentType: FilamentType = DEFAULT_FILAMENT,
): Promise<THREE.BufferGeometry> {
  if (joints.length === 0) return sourceGeometry.clone()
  const { cut, parts } = await cutWithManifold(
    sourceGeometry,
    joints,
    baseRadius,
    onProgress,
    filamentType,
  )
  for (const p of parts) {
    if (p !== cut) p.dispose()
  }
  return cut
}

export async function cutAndSplitModel(
  sourceGeometry: THREE.BufferGeometry,
  joints: Joint[],
  baseRadius: number,
  onProgress?: (p: CutProgress) => void,
  filamentType: FilamentType = DEFAULT_FILAMENT,
): Promise<CutResult> {
  if (joints.length === 0) {
    const clone = sourceGeometry.clone()
    return { cut: clone, parts: [clone.clone()], warnings: [], notes: [] }
  }
  return cutWithManifold(
    sourceGeometry,
    joints,
    baseRadius,
    onProgress,
    filamentType,
  )
}
