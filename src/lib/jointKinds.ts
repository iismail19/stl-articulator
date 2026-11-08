import type { JointKind } from '../types'

export type { JointKind }

/**
 * Articulation styles the user can pick per marker.
 * All kinds are selectable. `tested` is a label only — ball, hinge and knuckle
 * are confirmed by real prints; universal is not built.
 *
 * AC: editing or testing one kind must not rewrite markers or fit numbers of
 * another kind. Placement default ≠ per-marker kind; profiles stay in separate
 * modules (`filamentProfiles` vs `hingeProfile`).
 */
export interface JointKindProfile {
  id: JointKind
  label: string
  /** Where this joint belongs on a figure */
  useFor: string
  /** Short note under the checklist */
  hint: string
  /** True only after a real print confirmed the fit */
  tested: boolean
  /** Print status shown on the picker: tested, tested at standard size only, untested, or not built. */
  status: 'tested' | 'partly' | 'untested' | 'notBuilt'
}

/** Small label under each joint type button; null when fully tested. */
export function kindBadge(
  profile: JointKindProfile,
): { text: string; tone: 'ok' | 'todo' | 'off'; title: string } | null {
  if (profile.status === 'partly') {
    return {
      text: '✓ 9 mm tested',
      tone: 'ok',
      title: 'Ready to use. Print-tested at 9 mm wide; thinner sizes (like a 4″ figure’s knees) are not print-tested yet.',
    }
  }
  if (profile.status === 'untested') {
    return { text: 'test', tone: 'todo', title: 'Built and usable, but not print-tested yet — print its test pair first.' }
  }
  if (profile.status === 'notBuilt') {
    return { text: 'soon', tone: 'off', title: 'Not built yet — Preview only cuts here, no joint hardware.' }
  }
  return null
}

export const JOINT_KINDS: Record<JointKind, JointKindProfile> = {
  ball: {
    id: 'ball',
    label: 'Ball & socket',
    useFor: 'Neck, shoulders (armpit), hips, and any thick limb',
    hint: 'Print-tested. Full swing in every direction. Needs a thick enough limb so the stem survives.',
    tested: true,
    status: 'tested',
  },
  hinge: {
    id: 'hinge',
    label: 'Hinge',
    useFor: 'Elbow and knee — one bend axis',
    hint: 'Snap disc: a peg is molded onto one part and snaps through a hole in the other; the lip clamps the discs so the bend holds a pose. No separate pin. Print-tested ✓ — the peg is strongest printed upright (arm end down, with a brim).',
    tested: true,
    status: 'tested',
  },
  knuckle: {
    id: 'knuckle',
    label: 'Knuckle',
    useFor: 'Robot elbows, knees, ankles — the toy-robot look',
    hint: 'Rounded tongue in a fork, like a toy robot. Cone bumps molded on the fork snap into dimples on the tongue — no separate pin — and the fork pinches the tongue so the bend holds a pose. Print-tested ✓ at the standard 9 mm width and the thin 6.8 mm knee size.',
    tested: true,
    status: 'tested',
  },
  swivel: {
    id: 'swivel',
    label: 'Swivel',
    useFor: 'Forearm twist or waist turn',
    hint: 'Snap post along the limb: a split post molded on one part clicks into a hole in the other and turns all the way round; its lip clamps the faces so the twist holds. No separate pin. Print-tested ✓ — print the hole part hole-down so the catch edge stays crisp.',
    tested: true,
    status: 'tested',
  },
  universal: {
    id: 'universal',
    label: 'Universal',
    useFor: 'Wrist and ankle — two bend axes',
    hint: 'Not built yet — you can place a marker, but Preview only cuts. Use Ball, Hinge, Knuckle or Swivel for working hardware.',
    tested: false,
    status: 'notBuilt',
  },
}

export const DEFAULT_JOINT_KIND: JointKind = 'ball'

export const JOINT_KIND_ORDER: JointKind[] = ['ball', 'hinge', 'knuckle', 'swivel', 'universal']

/** Kinds that bend on one axis — their marker shows a pivot bar and auto-aims front-to-back. */
export function bendsOnOneAxis(kind: JointKind | undefined | null): boolean {
  const k = normalizeJointKind(kind)
  return k === 'hinge' || k === 'knuckle'
}

export function getJointKind(id: JointKind | undefined | null): JointKindProfile {
  return JOINT_KINDS[id ?? DEFAULT_JOINT_KIND] ?? JOINT_KINDS.ball
}

/** Saved joints from before kinds existed → ball. */
export function normalizeJointKind(id: unknown): JointKind {
  if (typeof id === 'string' && Object.hasOwn(JOINT_KINDS, id)) {
    return id as JointKind
  }
  return DEFAULT_JOINT_KIND
}
