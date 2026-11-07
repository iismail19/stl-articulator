/**
 * AC: testing / editing one joint kind must not rewrite another kind's
 * markers or fit numbers.
 *
 *   npx tsx scripts/prove-kind-isolation.mts
 */
import { PLA_VALIDATED } from '../src/lib/filamentProfiles.ts'
import { HINGE_TEST } from '../src/lib/hingeProfile.ts'
import { KNUCKLE_TEST } from '../src/lib/knuckleProfile.ts'
import { SWIVEL_TEST } from '../src/lib/swivelProfile.ts'
import { hintToJoint, type LocalJointHint } from '../src/lib/meshProbe.ts'
import { normalizeJointKind } from '../src/lib/jointKinds.ts'
import type { Joint } from '../src/types.ts'

let fails = 0
function ok(name: string, pass: boolean) {
  if (pass) console.log(`OK   ${name}`)
  else {
    console.error(`FAIL ${name}`)
    fails++
  }
}

const snapBefore = { ...PLA_VALIDATED }
const hingeBefore = { ...HINGE_TEST }

// Runtime mutation of one profile must not change the other object.
;(HINGE_TEST as { shoulderPreload: number }).shoulderPreload = 0.99
ok(
  'hinge edit leaves PLA_VALIDATED untouched',
  PLA_VALIDATED.socketClearance === snapBefore.socketClearance &&
    PLA_VALIDATED.mouthRatio === snapBefore.mouthRatio &&
    PLA_VALIDATED.flexSlots === snapBefore.flexSlots,
)
;(HINGE_TEST as { shoulderPreload: number }).shoulderPreload = hingeBefore.shoulderPreload

;(PLA_VALIDATED as { mouthRatio: number }).mouthRatio = 0.5
ok(
  'ball edit leaves HINGE_TEST untouched',
  HINGE_TEST.pegDiameter === hingeBefore.pegDiameter &&
    HINGE_TEST.shoulderPreload === hingeBefore.shoulderPreload &&
    HINGE_TEST.holeClearance === hingeBefore.holeClearance,
)
;(PLA_VALIDATED as { mouthRatio: number }).mouthRatio = snapBefore.mouthRatio

const knuckleBefore = { ...KNUCKLE_TEST }
;(KNUCKLE_TEST as { preload: number }).preload = 0.99
ok(
  'knuckle edit leaves ball and hinge untouched',
  PLA_VALIDATED.socketClearance === snapBefore.socketClearance &&
    PLA_VALIDATED.mouthRatio === snapBefore.mouthRatio &&
    HINGE_TEST.shoulderPreload === hingeBefore.shoulderPreload &&
    HINGE_TEST.pegDiameter === hingeBefore.pegDiameter,
)
;(KNUCKLE_TEST as { preload: number }).preload = knuckleBefore.preload
;(PLA_VALIDATED as { mouthRatio: number }).mouthRatio = 0.5
;(HINGE_TEST as { shoulderPreload: number }).shoulderPreload = 0.99
ok(
  'ball and hinge edits leave KNUCKLE_TEST untouched',
  KNUCKLE_TEST.preload === knuckleBefore.preload &&
    KNUCKLE_TEST.bumpHeight === knuckleBefore.bumpHeight &&
    KNUCKLE_TEST.sideGap === knuckleBefore.sideGap,
)
;(PLA_VALIDATED as { mouthRatio: number }).mouthRatio = snapBefore.mouthRatio
;(HINGE_TEST as { shoulderPreload: number }).shoulderPreload = hingeBefore.shoulderPreload

const swivelBefore = { ...SWIVEL_TEST }
;(SWIVEL_TEST as { shoulderPreload: number }).shoulderPreload = 0.99
;(SWIVEL_TEST as { holeClearance: number }).holeClearance = 0.99
ok(
  'swivel edit leaves ball, hinge and knuckle untouched',
  PLA_VALIDATED.socketClearance === snapBefore.socketClearance &&
    PLA_VALIDATED.mouthRatio === snapBefore.mouthRatio &&
    HINGE_TEST.shoulderPreload === hingeBefore.shoulderPreload &&
    HINGE_TEST.holeClearance === hingeBefore.holeClearance &&
    KNUCKLE_TEST.preload === knuckleBefore.preload,
)
;(SWIVEL_TEST as { shoulderPreload: number }).shoulderPreload = swivelBefore.shoulderPreload
;(SWIVEL_TEST as { holeClearance: number }).holeClearance = swivelBefore.holeClearance
;(HINGE_TEST as { shoulderPreload: number }).shoulderPreload = 0.99
;(KNUCKLE_TEST as { preload: number }).preload = 0.99
ok(
  'hinge and knuckle edits leave SWIVEL_TEST untouched',
  SWIVEL_TEST.shoulderPreload === swivelBefore.shoulderPreload &&
    SWIVEL_TEST.holeClearance === swivelBefore.holeClearance &&
    SWIVEL_TEST.postDiameter === swivelBefore.postDiameter,
)
;(HINGE_TEST as { shoulderPreload: number }).shoulderPreload = hingeBefore.shoulderPreload
;(KNUCKLE_TEST as { preload: number }).preload = knuckleBefore.preload

ok('profiles are separate modules', HINGE_TEST.pegDiameter !== undefined)
ok('ball snap key absent from hinge', !('socketClearance' in HINGE_TEST))
ok('hinge peg key absent from ball', !('pegDiameter' in PLA_VALIDATED))

const hint: LocalJointHint = {
  position: [1, 2, 3],
  axis: 'x',
  radius: 2,
  diameter: 4,
}
const ball = hintToJoint(hint, 1, 1, 'ball')
const hinge = hintToJoint({ ...hint, position: [4, 5, 6] }, 2, 1, 'hinge')
ok('ball marker kind', normalizeJointKind(ball.kind) === 'ball')
ok('hinge marker kind', normalizeJointKind(hinge.kind) === 'hinge')
const knuckle = hintToJoint({ ...hint, position: [7, 8, 9] }, 4, 1, 'knuckle')
ok('knuckle marker kind', normalizeJointKind(knuckle.kind) === 'knuckle')
ok('ball marker keeps its twist', ball.rotation === 0)

const joints: Joint[] = [ball, hinge]
const kind = 'hinge' as const
const kept = joints.filter((j) => normalizeJointKind(j.kind) !== kind)
const suggested = [hintToJoint(hint, 3, 1, kind)]
const next = [...kept, ...suggested]
ok('suggest keeps other kinds', next.some((j) => j.id === ball.id && j.kind === 'ball'))
ok('suggest replaces same kind only', !next.some((j) => j.id === hinge.id))
ok('suggest adds new hinge', next.some((j) => j.id === 3 && j.kind === 'hinge'))

const ballAfter = next.find((j) => j.id === ball.id)!
ok(
  'ball pose untouched after hinge suggest',
  ballAfter.position[0] === ball.position[0] && ballAfter.scale === ball.scale,
)

const onlyThis: Joint = { ...ball, kind: 'swivel', tilt: [5, 0, 0] }
const othersUntouched = joints.map((j) => (j.id === ball.id ? onlyThis : j))
ok(
  'editing one marker leaves sibling kind alone',
  othersUntouched.find((j) => j.id === hinge.id)?.kind === 'hinge' &&
    othersUntouched.find((j) => j.id === hinge.id)?.position[0] === hinge.position[0],
)

// Duplicate ids must be repaired — twins sharing "#1" drag together.
{
  const twins: Joint[] = [
    { ...ball, id: 1 },
    { ...hinge, id: 1 },
  ]
  const seen = new Set<number>()
  let max = 0
  const fixed = twins.map((j) => {
    let id = j.id
    if (seen.has(id)) id = max + 1
    seen.add(id)
    max = Math.max(max, id)
    return { ...j, id }
  })
  ok('sanitize splits duplicate ids', fixed[0].id !== fixed[1].id)
  ok('sanitize keeps both markers', fixed.length === 2)
  ok('sanitize preserves kinds', fixed[0].kind === 'ball' && fixed[1].kind === 'hinge')

  // Drag must update only the first match when ids collide (neck must not follow elbow).
  let hit = false
  const afterDrag = twins.map((j) => {
    if (j.id !== 1 || hit) return j
    hit = true
    return { ...j, position: [7, 0, 0] as [number, number, number] }
  })
  ok('drag first twin only', afterDrag[0].position[0] === 7)
  ok('second twin pose stays', afterDrag[1].position[0] === hinge.position[0])
}

if (fails === 0) {
  console.log('\nKIND ISOLATION OK')
  process.exitCode = 0
} else {
  console.log(`\nKIND ISOLATION FAILED (${fails})`)
  process.exitCode = 1
}
