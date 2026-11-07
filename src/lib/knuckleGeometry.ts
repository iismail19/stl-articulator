import type { ManifoldToplevel } from 'manifold-3d'
import { cylY } from './hingeGeometry'
import { knuckleLayout, type KnuckleSpec } from './knuckleProfile'

type ManifoldClass = ManifoldToplevel['Manifold']
type Solid = ReturnType<ManifoldClass['cube']>

/**
 * Knuckle-local space: bend axis = +Y through the origin, cut plane z = 0.
 * Fork part lives on −Z (two cheeks, rounded ends past the axis), tongue part
 * on +Z (one rounded plate between the cheeks).
 * Shared by the model cut and the printable test pair so both stay identical.
 */

function del(s: Solid | null | undefined) {
  try {
    s?.delete()
  } catch {
    /* already freed */
  }
}

function box(
  Manifold: ManifoldClass,
  min: [number, number, number],
  max: [number, number, number],
): Solid {
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  return Manifold.cube(size, false).translate(min)
}

function unite(Manifold: ManifoldClass, parts: Solid[]): Solid {
  const u = Manifold.union(parts)
  for (const p of parts) del(p)
  return u
}

function subtract(Manifold: ManifoldClass, a: Solid, b: Solid): Solid {
  const out = Manifold.difference(a, b)
  del(a)
  del(b)
  return out
}

/** Two cheeks with round ends + the bridge joining them below the tongue's swing. No bumps. */
export function buildForkBody(Manifold: ManifoldClass, K: KnuckleSpec, armReach: number): Solid {
  const L = knuckleLayout(K)
  const R = K.radius
  const bridgeTop = -L.swing
  const cheek = (y0: number, y1: number) =>
    unite(Manifold, [cylY(Manifold, y0, y1, R), box(Manifold, [-R, y0, -armReach], [R, y1, 0])])
  const parts = [cheek(-L.half, -L.cheekFace), cheek(L.cheekFace, L.half)]
  if (armReach > -bridgeTop) {
    parts.push(box(Manifold, [-R, -L.half, -armReach], [R, L.half, bridgeTop]))
  }
  return unite(Manifold, parts)
}

/** 45° cone bump on each cheek's inner face, rooted a little into the cheek. */
export function forkBumps(Manifold: ManifoldClass, K: KnuckleSpec): Solid {
  const L = knuckleLayout(K)
  const root = Math.min(0.3, K.cheek * 0.5)
  const f = L.cheekFace
  return unite(Manifold, [
    cylY(Manifold, -f - root, -f, K.bumpRadius),
    cylY(Manifold, -f, -f + K.bumpHeight, K.bumpRadius, L.bumpTipR),
    cylY(Manifold, f - K.bumpHeight, f, L.bumpTipR, K.bumpRadius),
    cylY(Manifold, f, f + root, K.bumpRadius),
  ])
}

export function buildFork(Manifold: ManifoldClass, K: KnuckleSpec, armReach: number): Solid {
  return unite(Manifold, [buildForkBody(Manifold, K, armReach), forkBumps(Manifold, K)])
}

/** Cone dimple on each tongue face; the bumps sit in these. */
export function tongueDimples(Manifold: ManifoldClass, K: KnuckleSpec): Solid {
  const L = knuckleLayout(K)
  const t = L.tongueHalf
  const out = 0.05
  return unite(Manifold, [
    cylY(Manifold, -t - out, -t + L.dimpleDepth, L.dimpleMouthR + out, L.dimpleBottomR),
    cylY(Manifold, t - L.dimpleDepth, t + out, L.dimpleBottomR, L.dimpleMouthR + out),
  ])
}

/** Round plate between the cheeks + arm toward +Z, without dimples. */
export function buildTongueBody(Manifold: ManifoldClass, K: KnuckleSpec, armReach: number): Solid {
  const L = knuckleLayout(K)
  const R = K.radius
  return unite(Manifold, [
    cylY(Manifold, -L.tongueHalf, L.tongueHalf, R),
    box(Manifold, [-R, -L.tongueHalf, 0], [R, L.tongueHalf, armReach]),
  ])
}

export function buildTongue(Manifold: ManifoldClass, K: KnuckleSpec, armReach: number): Solid {
  return subtract(Manifold, buildTongueBody(Manifold, K, armReach), tongueDimples(Manifold, K))
}

/**
 * Where each limb is cut back so the joint can swing.
 * Fork limb: a slot between the cheeks, deep enough for the tongue's round end.
 * Tongue limb: everything beside the tongue near the axis, so the cheeks fit.
 * `reach` bounds both so they never gouge a torso or a neighbouring limb.
 */
export function knuckleRecesses(
  Manifold: ManifoldClass,
  K: KnuckleSpec,
  reach: number,
): { forkLimb: Solid; tongueLimb: Solid } {
  const L = knuckleLayout(K)
  const c = L.swing
  return {
    forkLimb: box(Manifold, [-reach, -L.cheekFace, -c], [reach, L.cheekFace, reach]),
    tongueLimb: unite(Manifold, [
      box(Manifold, [-reach, L.tongueHalf, -reach], [reach, L.tongueHalf + reach, c]),
      box(Manifold, [-reach, -L.tongueHalf - reach, -reach], [reach, -L.tongueHalf, c]),
    ]),
  }
}

/** Round core of each part — used to build its clipping envelope. */
export function knuckleCores(Manifold: ManifoldClass, K: KnuckleSpec): { fork: Solid; tongue: Solid } {
  const L = knuckleLayout(K)
  return {
    fork: cylY(Manifold, -L.half, L.half, K.radius),
    tongue: cylY(Manifold, -L.tongueHalf, L.tongueHalf, K.radius),
  }
}
