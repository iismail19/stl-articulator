import * as THREE from 'three'
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export interface SimplifyResult {
  geometry: THREE.BufferGeometry
  before: number
  after: number
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex()
  if (index) return Math.floor(index.count / 3)
  return Math.floor(geometry.getAttribute('position').count / 3)
}

export type SimplifyStrength = 'light' | 'medium' | 'aggressive'

/** Map UI strength → keep-ratio + hard cap on triangles. */
export function targetForStrength(
  triangleCountNow: number,
  strength: SimplifyStrength,
): number {
  switch (strength) {
    case 'light':
      return Math.max(20_000, Math.floor(triangleCountNow * 0.55))
    case 'medium':
      return Math.min(80_000, Math.max(12_000, Math.floor(triangleCountNow * 0.3)))
    case 'aggressive':
      return Math.min(40_000, Math.max(8_000, Math.floor(triangleCountNow * 0.12)))
  }
}

/**
 * Decimate mesh toward a target triangle count (or ratio).
 * Helps CSG succeed on dense STLs — all in-browser, no Blender needed.
 */
export async function simplifyGeometry(
  source: THREE.BufferGeometry,
  options: {
    targetTriangles?: number
    ratio?: number
    strength?: SimplifyStrength
  } = {},
): Promise<SimplifyResult> {
  const before = triangleCount(source)
  const target =
    options.targetTriangles ??
    (options.strength
      ? targetForStrength(before, options.strength)
      : Math.max(8_000, Math.floor(before * (options.ratio ?? 0.35))))

  if (before <= target + 500) {
    return { geometry: source.clone(), before, after: before }
  }

  let geo = source.clone()
  // STL soups often have near-duplicate verts; weld at a size-aware tolerance or
  // Meshopt cannot collapse edges (stays at ~2M tris forever).
  geo.computeBoundingBox()
  const box = geo.boundingBox
  const extent = box
    ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-6)
    : 1
  const weldTol = Math.max(extent * 1e-5, 1e-4)
  geo = mergeVertices(geo, weldTol)
  // Drop shading attrs so the error metric can actually reach the target
  geo.deleteAttribute('normal')
  geo.deleteAttribute('uv')

  const verts = geo.getAttribute('position').count
  // SimplifyModifier count = vertices to remove (not triangles)
  const keepRatio = Math.min(1, Math.max(0.01, target / before))
  const removeCount = Math.max(0, Math.floor(verts * (1 - keepRatio)))

  const modifier = new SimplifyModifier()
  const simplified = await modifier.modify(geo, removeCount)
  geo.dispose()

  simplified.computeVertexNormals()

  const after = triangleCount(simplified)
  return { geometry: simplified, before, after }
}
