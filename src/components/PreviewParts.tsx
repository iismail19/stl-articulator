import { useMemo } from 'react'
import * as THREE from 'three'

const PART_COLORS = [
  '#94a3b8',
  '#38bdf8',
  '#fb923c',
  '#a3e635',
  '#e879f9',
  '#f472b6',
  '#2dd4bf',
  '#facc15',
  '#818cf8',
  '#f87171',
]

interface PreviewPartsProps {
  parts: THREE.BufferGeometry[]
  explode: number
}

function partCentroid(geometry: THREE.BufferGeometry): THREE.Vector3 {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  return new THREE.Vector3().addVectors(box.min, box.max).multiplyScalar(0.5)
}

export function PreviewParts({ parts, explode }: PreviewPartsProps) {
  const layout = useMemo(() => {
    const centroids = parts.map(partCentroid)
    const center = new THREE.Vector3()
    for (const c of centroids) center.add(c)
    if (centroids.length) center.multiplyScalar(1 / centroids.length)

    // Scale explode by model size so it feels right on tiny/large STLs
    let maxR = 0
    for (const c of centroids) {
      maxR = Math.max(maxR, c.distanceTo(center))
    }
    for (const g of parts) {
      g.computeBoundingSphere()
      maxR = Math.max(maxR, g.boundingSphere?.radius ?? 0)
    }
    const explodeScale = Math.max(maxR * 0.85, 1e-3)

    return centroids.map((c, i) => {
      const dir = c.clone().sub(center)
      if (dir.lengthSq() < 1e-12) {
        // Stacked/coincident — fan out in a ring
        const a = (i / Math.max(parts.length, 1)) * Math.PI * 2
        dir.set(Math.cos(a), 0.15, Math.sin(a))
      }
      dir.normalize()
      return {
        offset: dir.multiplyScalar(explode * explodeScale),
        color: PART_COLORS[i % PART_COLORS.length],
      }
    })
  }, [parts, explode])

  return (
    <group>
      {parts.map((geometry, i) => (
        <mesh key={i} geometry={geometry} position={layout[i].offset}>
          <meshStandardMaterial
            color={layout[i].color}
            metalness={0.12}
            roughness={0.5}
            flatShading={false}
          />
        </mesh>
      ))}
    </group>
  )
}
