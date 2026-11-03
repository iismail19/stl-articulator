/**
 * Load the Dag test figure at its 3-inch size (76.2 mm tall), centered.
 * Uses the 3-inch STL when present, else the 4-inch export scaled down, so
 * proofs and their saved joint coordinates keep working.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DAG_3IN_HEIGHT = 76.2

const CANDIDATES = [
  path.join(__dirname, '../fixtures/Dag_natural_happy_3inch.stl'),
  '/Users/wind/Downloads/Dag_natural_happy_3inch.stl',
  path.join(__dirname, '../fixtures/Dag_natural_happy_4inch.stl'),
  '/Users/wind/Downloads/Dag_natural_happy_4inch.stl',
]

export function loadDag3inch(): { geo: THREE.BufferGeometry; source: string } {
  const source = CANDIDATES.find((p) => fs.existsSync(p))
  if (!source) {
    throw new Error(`Missing Dag fixture — looked for:\n  ${CANDIDATES.join('\n  ')}`)
  }
  const buf = fs.readFileSync(source)
  const geo = new STLLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  )
  geo.computeBoundingBox()
  const h = geo.boundingBox!.max.z - geo.boundingBox!.min.z
  if (Math.abs(h - DAG_3IN_HEIGHT) > 0.5) {
    const s = DAG_3IN_HEIGHT / h
    geo.scale(s, s, s)
  }
  geo.computeVertexNormals()
  geo.center()
  geo.computeBoundingBox()
  return { geo, source }
}
