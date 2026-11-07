import type { ManifoldToplevel } from 'manifold-3d'
import { hingeLayout, type HingeSpec } from './hingeProfile'

type ManifoldClass = ManifoldToplevel['Manifold']
type Solid = ReturnType<ManifoldClass['cube']>

/**
 * Hinge-local space: bend axis = +Y through the origin, cut plane z = 0.
 * Stud part lives on +Z (disc on the −Y half), eye part on −Z (disc on the +Y half).
 * Shared by the model cut and the printable test pair so both stay identical.
 */

function del(s: Solid | null | undefined) {
  try {
    s?.delete()
  } catch {
    /* already freed */
  }
}

/** Cylinder / cone along +Y from y0 to y1. */
export function cylY(
  Manifold: ManifoldClass,
  y0: number,
  y1: number,
  r0: number,
  r1: number = r0,
  segs = 40,
): Solid {
  const raw = Manifold.cylinder(y1 - y0, r0, r1, segs, false)
  const rot = raw.rotate([-90, 0, 0])
  del(raw)
  const out = rot.translate([0, y0, 0])
  del(rot)
  return out
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

/** Disc + flat arm toward +Z + split snap peg along +Y. */
export function buildStud(Manifold: ManifoldClass, H: HingeSpec, armReach: number): Solid {
  const L = hingeLayout(H)
  const R = H.discRadius
  const [s0, s1] = L.stud
  const tipR = Math.max(L.pegR * 0.8, L.pegR - 0.25)
  let stud = unite(Manifold, [
    cylY(Manifold, s0, s1, R),
    box(Manifold, [-R, s0, 0], [R, s1, armReach]),
    // Peg starts inside the disc so it fuses solidly.
    cylY(Manifold, s1 - Math.min(0.4, H.studThickness * 0.3), L.shoulderY, L.pegR),
    cylY(Manifold, L.shoulderY, L.tipY, L.lipR, tipR),
  ])
  // Slot across the peg so its halves squeeze through the hole, then spring back.
  const slotZ = L.lipR + 0.5
  stud = subtract(
    Manifold,
    stud,
    box(Manifold, [-H.splitWidth / 2, s1 + 0.3, -slotZ], [H.splitWidth / 2, L.tipY + 1, slotZ]),
  )
  return stud
}

/** Disc with a through hole + flat arm toward −Z. */
export function buildEye(Manifold: ManifoldClass, H: HingeSpec, armReach: number): Solid {
  const L = hingeLayout(H)
  const R = H.discRadius
  const [e0, e1] = L.eye
  const eye = unite(Manifold, [
    cylY(Manifold, e0, e1, R),
    box(Manifold, [-R, e0, -armReach], [R, e1, 0]),
  ])
  return subtract(Manifold, eye, eyeBore(Manifold, H))
}

/** Hole through the eye plus a pocket past its outer face for the peg lip. */
export function eyeBore(Manifold: ManifoldClass, H: HingeSpec): Solid {
  const L = hingeLayout(H)
  const [e0, e1] = L.eye
  return unite(Manifold, [
    cylY(Manifold, e0 - 0.5, e1 + 0.01, L.holeR),
    cylY(Manifold, e1, L.tipY + 0.4, L.lipR + 0.3),
  ])
}

/**
 * Where each limb must be cut back so the other part's disc can swing.
 * Eye limb (−Z) loses the stud half near the axis; stud limb (+Z) loses the eye half.
 * `reach` bounds the cut so it never gouges a torso or a neighbouring limb.
 */
export function motionRecesses(
  Manifold: ManifoldClass,
  H: HingeSpec,
  reach: number,
): { eyeLimb: Solid; studLimb: Solid } {
  const L = hingeLayout(H)
  const c = H.discRadius + H.motionClearance
  return {
    eyeLimb: box(Manifold, [-reach, L.split - reach, -c], [reach, L.split, reach]),
    studLimb: box(Manifold, [-reach, L.split, -reach], [reach, L.split + reach, c]),
  }
}

/** Round core of each part (disc, plus the peg on the stud) — used to build its envelope. */
export function hingeCores(Manifold: ManifoldClass, H: HingeSpec): { stud: Solid; eye: Solid } {
  const L = hingeLayout(H)
  return {
    stud: cylY(Manifold, L.stud[0], L.tipY + 0.05, H.discRadius),
    eye: cylY(Manifold, L.eye[0], L.eye[1], H.discRadius),
  }
}
