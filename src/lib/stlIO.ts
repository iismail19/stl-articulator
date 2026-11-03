import { zipSync } from 'fflate'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { ModelInfo } from '../types'

export async function loadStlFile(file: File): Promise<{
  geometry: THREE.BufferGeometry
  info: ModelInfo
}> {
  const buffer = await file.arrayBuffer()
  const loader = new STLLoader()
  const geometry = loader.parse(buffer)
  geometry.computeVertexNormals()
  geometry.center()
  geometry.computeBoundingBox()

  const box = geometry.boundingBox!
  const size: [number, number, number] = [
    box.max.x - box.min.x,
    box.max.y - box.min.y,
    box.max.z - box.min.z,
  ]

  const pos = geometry.getAttribute('position')
  const triangles = Math.floor(pos.count / 3)

  return {
    geometry,
    info: {
      name: file.name,
      size,
      triangles,
    },
  }
}

export function geometryToStlBlob(geometry: THREE.BufferGeometry, binary = true): Blob {
  const mesh = new THREE.Mesh(geometry)
  const exporter = new STLExporter()
  if (binary) {
    const result = exporter.parse(mesh, { binary: true }) as DataView
    const copy = new ArrayBuffer(result.byteLength)
    new Uint8Array(copy).set(
      new Uint8Array(result.buffer, result.byteOffset, result.byteLength),
    )
    return new Blob([copy], { type: 'application/octet-stream' })
  }
  const result = exporter.parse(mesh, { binary: false }) as string
  return new Blob([result], { type: 'text/plain' })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking synchronously can cancel the download before the browser reads it
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** Browsers block back-to-back downloads, so multi-file exports go out as one zip. */
export async function downloadStlZip(
  files: { name: string; geometry: THREE.BufferGeometry }[],
  zipName: string,
): Promise<void> {
  const entries: Record<string, Uint8Array> = {}
  for (const f of files) {
    entries[f.name] = new Uint8Array(await geometryToStlBlob(f.geometry).arrayBuffer())
  }
  const zipped = zipSync(entries, { level: 6 })
  downloadBlob(new Blob([zipped.slice().buffer], { type: 'application/zip' }), zipName)
}

export function formatSize(size: [number, number, number]): string {
  const fmt = (n: number) => {
    if (n >= 10) return n.toFixed(1)
    if (n >= 1) return n.toFixed(2)
    return n.toFixed(3)
  }
  return `${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])}`
}

export function suggestBaseRadius(size: [number, number, number]): number {
  const minDim = Math.min(...size)
  return Math.max(minDim * 0.12, 1e-3)
}
