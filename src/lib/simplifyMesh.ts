import * as THREE from 'three'
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { getManifold, manifoldToGeometry, tryMakeManifold } from './manifoldEngine'

export interface SimplifyResult {
  geometry: THREE.BufferGeometry
  before: number
  after: number
  /** False only when the input already had holes and the fallback decimator ran. */
  watertight: boolean
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

/** Largest allowed surface error, as a fraction of the model's longest side. */
const MAX_ERROR = 4e-3

/**
 * Decimate mesh toward a target triangle count (or ratio).
 * Helps CSG succeed on dense STLs — all in-browser, no Blender needed.
 *
 * Watertight input stays watertight: Manifold's simplify only collapses edges
 * that keep the solid closed, so the cut engine can still read the result.
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
    return { geometry: source.clone(), before, after: before, watertight: true }
  }

  source.computeBoundingBox()
  const box = source.boundingBox!
  const extent = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-6)

  const { Manifold, Mesh } = await getManifold()
  let solid: ReturnType<typeof tryMakeManifold> | null = null
  try {
    solid = tryMakeManifold(Mesh, Manifold, source, extent)
  } catch {
    solid = null
  }

  if (solid) {
    let eps = extent * 1e-4
    let current = solid
    for (;;) {
      const next = current.simplify(eps)
      if (current !== solid) current.delete()
      current = next
      if (current.numTri() <= target || eps >= extent * MAX_ERROR) break
      eps = Math.min(eps * 2, extent * MAX_ERROR)
      await new Promise((r) => setTimeout(r, 0))
    }
    const geometry = manifoldToGeometry(current)
    if (current !== solid) current.delete()
    solid.delete()
    return { geometry, before, after: triangleCount(geometry), watertight: true }
  }

  // Input already has holes: Manifold can't read it, so decimate the triangle soup.
  let geo = source.clone()
  // STL soups often have near-duplicate verts; weld at a size-aware tolerance or
  // the decimator cannot collapse edges (stays at ~2M tris forever).
  geo = mergeVertices(geo, Math.max(extent * 1e-5, 1e-4))
  // Drop shading attrs so the error metric can actually reach the target
  geo.deleteAttribute('normal')
  geo.deleteAttribute('uv')

  const verts = geo.getAttribute('position').count
  // SimplifyModifier count = vertices to remove (not triangles)
  const keepRatio = Math.min(1, Math.max(0.01, target / before))
  const removeCount = Math.max(0, Math.floor(verts * (1 - keepRatio)))

  const simplified = new SimplifyModifier().modify(geo, removeCount)
  geo.dispose()
  simplified.computeVertexNormals()
  return { geometry: simplified, before, after: triangleCount(simplified), watertight: false }
}
