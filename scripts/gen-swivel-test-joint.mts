/**
 * Swivel print test: post part (split snap post) + bore part (hole). No separate pin.
 * Geometry comes from src/lib/swivelGeometry.ts — the same code the model cut uses.
 *
 *   npx tsx scripts/gen-swivel-test-joint.mts
 *
 * Post part lies on its side on a small flat, post sideways (layers run along it).
 * Bore part stands on its end, hole opening up, so the hole prints round.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'manifold-3d'
import type { Mat4 } from 'manifold-3d'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { buildBoreBody, buildPostBody, swivelBore } from '../src/lib/swivelGeometry.ts'
import { SWIVEL_TEST, swivelLayout, swivelTestSpec } from '../src/lib/swivelProfile.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '../public/test-joints')

type ManifoldApi = Awaited<ReturnType<typeof Module>>
type Solid = ReturnType<ManifoldApi['Manifold']['sphere']>

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

async function main() {
  const wasm = await Module()
  wasm.setup()
  const { Manifold } = wasm
  const S = swivelTestSpec()
  const L = swivelLayout(S)
  const reach = SWIVEL_TEST.bodyLength
  console.log('Swivel test (mm):', {
    version: SWIVEL_TEST.version,
    collarDiameter: S.collarRadius * 2,
    post: S.postDiameter,
    hole: +(L.holeR * 2).toFixed(2),
    lipDiameter: +(L.lipR * 2).toFixed(2),
    preload: S.shoulderPreload,
  })

  const post = buildPostBody(Manifold, S, reach)
  const boreBody = buildBoreBody(Manifold, S, reach)
  const cavity = swivelBore(Manifold, S)
  const bore = Manifold.difference(boreBody, cavity)
  boreBody.delete()
  cavity.delete()

  // Assembled, then twisted: only the intended lip clamp may overlap.
  const clampVol = Math.PI * (L.lipR ** 2 - L.holeR ** 2) * S.shoulderPreload
  for (const deg of [0, 45, 90, 180]) {
    const turned = post.rotate([0, 0, deg])
    const hit = Manifold.intersection(bore, turned)
    const v = hit.isEmpty() ? 0 : hit.volume()
    hit.delete()
    turned.delete()
    const ok = v > 0 && v <= clampVol * 1.6 + 0.01
    console.log(`${ok ? 'OK  ' : 'FAIL'} twist ${deg}° overlap ${v.toFixed(4)} mm³ (clamp ring ${clampVol.toFixed(4)})`)
    if (!ok) throw new Error(`Post and bore collide at ${deg}°`)
  }

  // Post part: post axis (local Z) → world X, slot (thin in local X) → world Y so its
  // walls print vertical; local Y → up. Then shave a flat so it can't roll.
  const turn = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1] as unknown as Mat4
  const side = post.transform(turn)
  post.delete()
  const flat = 0.6
  const keep = Manifold.cube([100, 100, 100], false).translate([-50, -50, -S.collarRadius + flat])
  const shaved = Manifold.intersection(side, keep)
  side.delete()
  keep.delete()
  const postFlat = shaved.translate([0, 0, S.collarRadius - flat])
  shaved.delete()

  // Bore part: stands on its far end, hole opening up.
  const boreUp = bore.translate([0, 0, reach])
  bore.delete()

  fs.mkdirSync(outDir, { recursive: true })
  for (const f of fs.readdirSync(outDir)) {
    if (/^swivel-(post|bore)-v\d+\.stl$/.test(f)) fs.rmSync(path.join(outDir, f))
  }
  for (const [solid, name] of [
    [postFlat, 'post'],
    [boreUp, 'bore'],
  ] as const) {
    const geo = solidToGeo(solid)
    solid.delete()
    writeStl(geo, path.join(outDir, `swivel-${name}-${SWIVEL_TEST.version}.stl`))
    geo.dispose()
  }
  console.log('Done →', outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
