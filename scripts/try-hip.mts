/**
 * Run the user's saved 4-inch Dag joints and report what each joint did.
 *   npx tsx scripts/try-hip.mts
 */
import fs from 'node:fs'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { cutAndSplitModel } from '../src/lib/booleanCut.ts'
import { clampJointScales, prepareProbeMesh, refitJointsToLimbs } from '../src/lib/meshProbe.ts'
import { suggestBaseRadius } from '../src/lib/stlIO.ts'
import type { Joint } from '../src/types.ts'

const stl = '/Users/wind/Downloads/Dag_natural_happy_4inch.stl'
const buf = fs.readFileSync(stl)
const geo = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
geo.computeVertexNormals()
geo.center()
geo.computeBoundingBox()
const size = geo.boundingBox!.max.clone().sub(geo.boundingBox!.min)
const modelSize = Math.max(size.x, size.y, size.z)
const baseRadius = suggestBaseRadius([size.x, size.y, size.z])
const mesh = prepareProbeMesh(geo)
const maxScale = Math.min(3.2, (modelSize * 0.16) / baseRadius)

const joints = JSON.parse(fs.readFileSync(process.argv[2] ?? '/tmp/joints4.json', 'utf8')) as Joint[]
;(globalThis as { __ARTIC_DEBUG?: boolean }).__ARTIC_DEBUG = true
const fitted = clampJointScales(refitJointsToLimbs(mesh, joints, baseRadius, modelSize), maxScale)
const { parts, warnings, cut } = await cutAndSplitModel(geo, fitted, baseRadius, undefined, 'pla')
console.log(`parts=${parts.length}`)
for (const w of warnings) console.log('WARN', w)
cut.dispose()
for (const p of parts) p.dispose()
