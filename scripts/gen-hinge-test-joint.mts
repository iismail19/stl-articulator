/**
 * Elbow/knee hinge print test: snap-disc stud (peg) + eye (hole). No separate pin.
 * Geometry comes from src/lib/hingeGeometry.ts — the same code the model cut uses.
 *
 *   npx tsx scripts/gen-hinge-test-joint.mts
 *
 * Print-tested and LOCKED (prove-hinge-locked.mts). Stud printed upright on its
 * arm end with a brim (peg sideways = stronger); eye flat on its disc face.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'manifold-3d'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { buildEye, buildStud } from '../src/lib/hingeGeometry.ts'
import { HINGE_TEST, hingeLayout, hingeTestSpec } from '../src/lib/hingeProfile.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '../public/test-joints')

type ManifoldApi = Awaited<ReturnType<typeof Module>>
type ManifoldClass = ManifoldApi['Manifold']
type Solid = ReturnType<ManifoldClass['sphere']>

function solidToGeo(solid: Solid): THREE.BufferGeometry {
  const mesh = solid.getMesh()
  const n = mesh.numProp
  const pos = new Float32Array(mesh.numVert * 3)
  for (let i = 0; i < mesh.numVert; i++) {
    pos[i * 3] = mesh.vertProperties[i * n]
    pos[i * 3 + 1] = mesh.vertProperties[i * n + 1]
    pos[i * 3 + 2] = mesh.vertProperties[i * n + 2]
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setIndex(Array.from(mesh.triVerts))
  geo.computeVertexNormals()
  return geo
}

function writeStl(geo: THREE.BufferGeometry, file: string) {
  const data = new STLExporter().parse(new THREE.Mesh(geo), { binary: true }) as DataView
  fs.writeFileSync(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  console.log('Wrote', file, `(${(fs.statSync(file).size / 1024).toFixed(1)} KB)`)
}

/** Hinge axis (+Y) → up, then sit on the bed. */
function layFlat(solid: Solid): Solid {
  const up = solid.rotate([90, 0, 0])
  const minZ = up.boundingBox().min[2]
  const out = up.translate([0, 0, -minZ])
  up.delete()
  return out
}

async function main() {
  const wasm = await Module()
  wasm.setup()
  const { Manifold } = wasm
  const H = hingeTestSpec()
  const L = hingeLayout(H)
  const armReach = H.discRadius + HINGE_TEST.armLength
  console.log('Hinge test (mm):', {
    version: HINGE_TEST.version,
    discDiameter: H.discRadius * 2,
    peg: H.pegDiameter,
    hole: +(L.holeR * 2).toFixed(2),
    lipDiameter: +(L.lipR * 2).toFixed(2),
    preload: H.shoulderPreload,
  })

  const stud = buildStud(Manifold, H, armReach)
  const eye = buildEye(Manifold, H, armReach)

  // Assembled, then swung through the bend: only the intended lip clamp may overlap.
  const clampVol = Math.PI * (L.lipR ** 2 - L.holeR ** 2) * H.shoulderPreload
  for (const deg of [0, 45, 90, 135]) {
    const swung = eye.rotate([0, deg, 0])
    const hit = Manifold.intersection(stud, swung)
    const v = hit.isEmpty() ? 0 : hit.volume()
    hit.delete()
    swung.delete()
    const ok = v <= clampVol * 1.6 + 0.01
    console.log(`${ok ? 'OK  ' : 'FAIL'} bend ${deg}° overlap ${v.toFixed(3)} mm³ (clamp ring ${clampVol.toFixed(3)})`)
    if (!ok) throw new Error(`Stud and eye collide at ${deg}°`)
  }

  fs.mkdirSync(outDir, { recursive: true })
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith('hinge-')) fs.rmSync(path.join(outDir, f))
  }
  for (const [solid, name] of [
    [stud, 'stud'],
    [eye, 'eye'],
  ] as const) {
    const flat = layFlat(solid)
    solid.delete()
    const geo = solidToGeo(flat)
    flat.delete()
    writeStl(geo, path.join(outDir, `hinge-${name}-${HINGE_TEST.version}.stl`))
    geo.dispose()
  }
  console.log('Done →', outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
