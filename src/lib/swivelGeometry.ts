import type { ManifoldToplevel } from 'manifold-3d'
import { swivelLayout, type SwivelSpec } from './swivelProfile'

type ManifoldClass = ManifoldToplevel['Manifold']
type Solid = ReturnType<ManifoldClass['cube']>

/**
 * Swivel-local space: turn axis = Z through the origin, the two collars meet at
 * z = 0. Post part on +Z (post pointing down), bore part on −Z.
 * Shared by the model cut and the printable test pair so both stay identical.
 */

function del(s: Solid | null | undefined) {
  try {
    s?.delete()
  } catch {
    /* already freed */
  }
}

/** Cylinder / cone along +Z from z0 to z1. */
function cylZ(Manifold: ManifoldClass, z0: number, z1: number, r0: number, r1: number = r0, segs = 48): Solid {
  const raw = Manifold.cylinder(z1 - z0, r0, r1, segs, false)
  const out = raw.translate([0, 0, z0])
  del(raw)
  return out
}

function unite(Manifold: ManifoldClass, parts: Solid[]): Solid {
  const u = Manifold.union(parts)
  for (const p of parts) del(p)
  return u
}

/** Collar reaching up to z = `reach`, plus the split snap post pointing down. */
export function buildPostBody(Manifold: ManifoldClass, S: SwivelSpec, reach: number): Solid {
  const L = swivelLayout(S)
  const tipR = Math.max(L.postR * 0.8, L.postR - 0.25)
  const body = unite(Manifold, [
    cylZ(Manifold, 0, reach, S.collarRadius),
    // Post starts inside the collar so it fuses solidly.
    cylZ(Manifold, L.shoulderZ, Math.min(0.4, reach * 0.3), L.postR),
    cylZ(Manifold, L.tipZ, L.shoulderZ, tipR, L.lipR),
  ])
  const slot = postSlot(Manifold, S, reach)
  const out = Manifold.difference(body, slot)
  del(body)
  del(slot)
  return out
}

/**
 * Slot across the post so its halves squeeze through the hole, then spring back.
 * It runs up into the collar so the halves are long enough to flex past the lip
 * without cracking. The model cut subtracts it again after joining the limb.
 */
export function postSlot(Manifold: ManifoldClass, S: SwivelSpec, reach: number): Solid {
  const L = swivelLayout(S)
  const slotY = L.lipR + 0.5
  const top = Math.min(S.postDiameter * 0.6, reach * 0.5)
  return Manifold.cube([S.splitWidth, slotY * 2, top - (L.tipZ - 1)], false).translate([
    -S.splitWidth / 2,
    -slotY,
    L.tipZ - 1,
  ])
}

/** Collar reaching down to z = −`reach`. The hole is cut separately (`swivelBore`). */
export function buildBoreBody(Manifold: ManifoldClass, S: SwivelSpec, reach: number): Solid {
  return cylZ(Manifold, -reach, 0, S.collarRadius)
}

/** Hole through the collar, a chamfered mouth, and the pocket below that the lip opens into. */
export function swivelBore(Manifold: ManifoldClass, S: SwivelSpec): Solid {
  const L = swivelLayout(S)
  const c = S.entryChamfer
  return unite(Manifold, [
    cylZ(Manifold, -S.boreDepth - 0.01, 0.01, L.holeR),
    cylZ(Manifold, -c, 0.01, L.holeR, L.holeR + c + 0.01),
    cylZ(Manifold, L.pocketZ, -S.boreDepth, L.lipR + 0.3),
  ])
}

/** Round core of each part — the limb envelope is the hull of the limb end and this. */
export function swivelCores(Manifold: ManifoldClass, S: SwivelSpec): { post: Solid; bore: Solid } {
  const L = swivelLayout(S)
  return {
    post: cylZ(Manifold, L.tipZ - 0.05, 0.01, S.collarRadius),
    bore: cylZ(Manifold, L.pocketZ - 0.05, 0, S.collarRadius),
  }
}
