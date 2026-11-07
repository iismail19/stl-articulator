import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Sidebar } from './components/Sidebar'
import { Viewport } from './components/Viewport'
import { cutAndSplitModel, cutJointsFromModel } from './lib/booleanCut'
import { createBallHardwareGeometry } from './lib/ballHardware'
import {
  DEFAULT_FILAMENT,
  FILAMENT_PROFILES,
  getFilamentProfile,
} from './lib/filamentProfiles'
import {
  DEFAULT_JOINT_KIND,
  getJointKind,
  bendsOnOneAxis,
  normalizeJointKind,
} from './lib/jointKinds'
import {
  applyJointTransform,
  createCutterGeometry,
  figureAxes,
  frontBackHingeTwist,
} from './lib/cutterGeometry'
import {
  disposeProbeGeometry,
  enlargeJoints,
  hintToJoint,
  prepareProbeMesh,
  probeJointAtPoint,
  clampJointScales,
  refitJointsToLimbs,
  type ProbeMesh,
} from './lib/meshProbe'
import { suggestFigureJoints } from './lib/figureTemplate'
import { predictSocketSide, socketSideKey, type SocketSide } from './lib/hostSide'
import { simplifyGeometry, type SimplifyStrength } from './lib/simplifyMesh'
import {
  downloadBlob,
  downloadStlZip,
  geometryToStlBlob,
  loadStlFile,
  suggestBaseRadius,
} from './lib/stlIO'
import type { FilamentType, Joint, JointKind, ModelInfo } from './types'
import './App.css'

let nextJointId = 1

/** The side the last preview actually built, valid while the marker is unchanged. */
type BuiltSides = Record<number, { key: string; side: SocketSide }>

// v2: joints stay on the cut (old saves recentered into limbs and broke sockets)
const JOINTS_KEY = (name: string) => `stl-articulator-joints:v2:${name}`

/**
 * Every marker must have a unique id. Duplicate ids make React keys collide and
 * cause drag/select/delete to hit every twin — e.g. a neck and an elbow both
 * "#1" get dragged to the same spot when either moves.
 */
function syncNextJointId(joints: Joint[]) {
  let max = 0
  for (const j of joints) {
    if (typeof j.id === 'number' && j.id > max) max = j.id
  }
  if (nextJointId <= max) nextJointId = max + 1
}

function allocJointId(existing: Joint[]): number {
  syncNextJointId(existing)
  return nextJointId++
}

/** Reassign colliding ids; normalize kind. Call on load and before persist. */
function sanitizeJoints(joints: Joint[]): Joint[] {
  const seen = new Set<number>()
  let max = 0
  const out: Joint[] = []
  for (const j of joints) {
    let id = typeof j.id === 'number' && Number.isFinite(j.id) ? j.id : 0
    if (id < 1 || seen.has(id)) {
      id = Math.max(max, ...seen, nextJointId - 1) + 1
    }
    seen.add(id)
    max = Math.max(max, id)
    out.push({
      ...j,
      id,
      axis: j.axis === 'x' || j.axis === 'z' ? j.axis : 'y',
      scale: typeof j.scale === 'number' ? j.scale : 1,
      rotation: typeof j.rotation === 'number' ? j.rotation : 0,
      tilt: Array.isArray(j.tilt) ? (j.tilt as [number, number, number]) : [0, 0, 0],
      kind: normalizeJointKind(j.kind),
      position: j.position,
    })
  }
  syncNextJointId(out)
  return out
}

function loadSavedJoints(modelName: string): Joint[] | null {
  try {
    const raw = localStorage.getItem(JOINTS_KEY(modelName))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Joint[]
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return sanitizeJoints(parsed)
  } catch {
    return null
  }
}

function saveJoints(modelName: string, joints: Joint[]) {
  try {
    if (joints.length === 0) localStorage.removeItem(JOINTS_KEY(modelName))
    else localStorage.setItem(JOINTS_KEY(modelName), JSON.stringify(sanitizeJoints(joints)))
  } catch {
    /* ignore quota */
  }
}

function disposeParts(parts: THREE.BufferGeometry[] | null) {
  if (!parts) return
  for (const p of parts) p.dispose()
}

function infoFromGeometry(name: string, geometry: THREE.BufferGeometry): ModelInfo {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  const size: [number, number, number] = [
    box.max.x - box.min.x,
    box.max.y - box.min.y,
    box.max.z - box.min.z,
  ]
  const index = geometry.getIndex()
  const triangles = index
    ? Math.floor(index.count / 3)
    : Math.floor(geometry.getAttribute('position').count / 3)
  return { name, size, triangles }
}

export default function App() {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null)
  const [model, setModel] = useState<ModelInfo | null>(null)
  const [joints, setJoints] = useState<Joint[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [placing, setPlacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [infoMsg, setInfoMsg] = useState<string | null>(null)

  const [previewParts, setPreviewParts] = useState<THREE.BufferGeometry[] | null>(null)
  const [previewCut, setPreviewCut] = useState<THREE.BufferGeometry | null>(null)
  const [builtSides, setBuiltSides] = useState<BuiltSides>({})
  const [explode, setExplode] = useState(0.45)
  const [simplifyStrength, setSimplifyStrength] = useState<SimplifyStrength>('medium')
  const [canUndoSimplify, setCanUndoSimplify] = useState(false)
  const [filament, setFilament] = useState<FilamentType>(() => {
    try {
      const saved = localStorage.getItem('stl-articulator-filament')
      if (saved && Object.hasOwn(FILAMENT_PROFILES, saved)) {
        const id = saved as FilamentType
        if (FILAMENT_PROFILES[id].tested) return id
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_FILAMENT
  })
  const [jointKind, setJointKind] = useState<JointKind>(() => {
    try {
      return normalizeJointKind(localStorage.getItem('stl-articulator-joint-kind'))
    } catch {
      /* ignore */
    }
    return DEFAULT_JOINT_KIND
  })

  const probeRef = useRef<ProbeMesh | null>(null)
  const originalGeoRef = useRef<THREE.BufferGeometry | null>(null)
  const originalInfoRef = useRef<ModelInfo | null>(null)

  const baseRadius = useMemo(
    () => (model ? suggestBaseRadius(model.size) : 1),
    [model],
  )

  const modelSize = useMemo(() => {
    if (!model) return 1
    return Math.max(...model.size, 1e-6)
  }, [model])

  const socketSides = useMemo(() => {
    const out: Record<number, SocketSide> = {}
    for (const j of joints) {
      const built = builtSides[j.id]
      out[j.id] =
        built && built.key === socketSideKey(j)
          ? built.side
          : predictSocketSide(j, joints, modelSize, model ? figureAxes(model.size) : undefined)
    }
    return out
  }, [joints, builtSides, modelSize, model])

  const rebuildProbe = useCallback((geo: THREE.BufferGeometry) => {
    disposeProbeGeometry(probeRef.current?.geometry ?? geo)
    probeRef.current = prepareProbeMesh(geo)
  }, [])

  const clearPreview = useCallback(() => {
    setPreviewParts((prev) => {
      disposeParts(prev)
      return null
    })
    setPreviewCut((prev) => {
      prev?.dispose()
      return null
    })
  }, [])

  const setFilamentAndPersist = useCallback(
    (next: FilamentType) => {
      setFilament(next)
      try {
        localStorage.setItem('stl-articulator-filament', next)
      } catch {
        /* ignore */
      }
      clearPreview()
      setInfoMsg(
        `Filament set to ${getFilamentProfile(next).label} — affects ball & socket snap only. Re-run Preview to rebuild. Hinge / other kinds keep their own profiles.`,
      )
    },
    [clearPreview],
  )

  const setJointKindAndPersist = useCallback((next: JointKind) => {
    // Placement default only — never rewrites markers already on the model.
    setJointKind(next)
    try {
      localStorage.setItem('stl-articulator-joint-kind', next)
    } catch {
      /* ignore */
    }
    const profile = getJointKind(next)
    setInfoMsg(
      `New markers will be ${profile.label}. Existing joints keep their own type and settings.`,
    )
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (previewParts) clearPreview()
        else setPlacing(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewParts, clearPreview])

  // Tiny persist — same STL name restores joints after refresh (no re-clicking)
  useEffect(() => {
    if (!model) return
    saveJoints(model.name, joints)
  }, [model, joints])

  // HMR / stale saves can leave two markers with id 1 — drag then moves both
  // (neck collapses onto the elbow). Repair once and keep the allocator ahead.
  useEffect(() => {
    syncNextJointId(joints)
    const ids = joints.map((j) => j.id)
    if (ids.length === new Set(ids).size) return
    const fixed = sanitizeJoints(joints)
    setJoints(fixed)
    setSelectedId((cur) => {
      if (cur == null) return cur
      if (fixed.some((j) => j.id === cur)) return cur
      return fixed[0]?.id ?? null
    })
    setInfoMsg(
      'Repaired duplicate joint IDs so each marker is independent. Check neck / elbow — a shared ID had been moving them together.',
    )
  }, [joints])

  const handleLoad = useCallback(
    async (file: File) => {
      setError(null)
      setInfoMsg(null)
      clearPreview()
      try {
        const { geometry: geo, info } = await loadStlFile(file)
        originalGeoRef.current?.dispose()
        originalGeoRef.current = geo.clone()
        originalInfoRef.current = { ...info }
        setCanUndoSimplify(false)
        setBuiltSides({})
        setGeometry((prev) => {
          if (prev) disposeProbeGeometry(prev)
          prev?.dispose()
          return geo
        })
        rebuildProbe(geo)
        setModel(info)
        const saved = loadSavedJoints(info.name)
        if (saved) {
          setJoints(saved)
          nextJointId = Math.max(...saved.map((j) => j.id)) + 1
          setSelectedId(saved[0]?.id ?? null)
          setInfoMsg(
            `Restored ${saved.length} saved joint(s) for ${info.name}. Hit Preview when ready.`,
          )
        } else {
          setJoints([])
          nextJointId = 1
          setSelectedId(null)
          if (info.triangles > 150_000) {
            setInfoMsg(
              `Dense mesh (${info.triangles.toLocaleString()} tris). Use Simplify Mesh in the sidebar (no Blender needed), then Auto-Suggest Joints.`,
            )
          }
        }
        setPlacing(false)
      } catch (err) {
        console.error(err)
        setError('Failed to load STL. Make sure the file is a valid binary or ASCII STL.')
      }
    },
    [clearPreview, rebuildProbe],
  )

  const clearModel = useCallback(() => {
    clearPreview()
    setGeometry((prev) => {
      if (prev) disposeProbeGeometry(prev)
      prev?.dispose()
      return null
    })
    originalGeoRef.current?.dispose()
    originalGeoRef.current = null
    originalInfoRef.current = null
    setCanUndoSimplify(false)
    probeRef.current = null
    setModel(null)
    setJoints([])
    nextJointId = 1
    setSelectedId(null)
    setPlacing(false)
  }, [clearPreview])

  const placeJoint = useCallback(
    (point: THREE.Vector3, normal: THREE.Vector3) => {
      const mesh = probeRef.current ?? (geometry ? prepareProbeMesh(geometry) : null)
      if (mesh) probeRef.current = mesh
      const kind = normalizeJointKind(jointKind)
      setJoints((prev) => {
        const id = allocJointId(prev)
        let joint: Joint
        if (mesh && model) {
          const hint = probeJointAtPoint(mesh, point, normal, modelSize)
          joint = { ...hintToJoint(hint, id, baseRadius, kind) }
        } else {
          joint = {
            id,
            position: [point.x, point.y, point.z],
            axis: 'y',
            scale: 1,
            rotation: 0,
            tilt: [0, 0, 0],
            kind,
          }
        }
        setSelectedId(joint.id)
        setInfoMsg(
          `Joint #${joint.id} (${getJointKind(kind).label}) placed. Aim the white arrow along the limb (Cut Axis + Tilt X/Y/Z).`,
        )
        return [...prev, joint]
      })
      setPlacing(false)
      clearPreview()
      setError(null)
    },
    [baseRadius, model, modelSize, geometry, clearPreview, jointKind],
  )

  const updateJoint = useCallback(
    (id: number, patch: Partial<Joint>) => {
      setJoints((prev) => {
        // If twins somehow share an id, only the first match updates — never
        // drag every duplicate (that pulled the neck onto the elbow).
        let hit = false
        return prev.map((j) => {
          if (j.id !== id || hit) return j
          hit = true
          const merged: Joint = {
            ...j,
            ...patch,
            id: j.id,
            kind: normalizeJointKind(patch.kind ?? j.kind),
          }
          // A hinge/knuckle twist sets which way it bends; aim it front-to-back
          // whenever a marker becomes one or its cut axis changes.
          const becameHinge = bendsOnOneAxis(merged.kind) && !bendsOnOneAxis(j.kind)
          if (
            bendsOnOneAxis(merged.kind) &&
            patch.rotation == null &&
            (becameHinge || (patch.axis != null && patch.axis !== j.axis))
          ) {
            merged.rotation = frontBackHingeTwist(
              merged,
              model ? figureAxes(model.size) : undefined,
            )
          }
          const moved = patch.position != null || patch.axis != null
          if (moved && probeRef.current) {
            const [fitted] = refitJointsToLimbs(
              probeRef.current,
              [merged],
              baseRadius,
              modelSize,
            )
            return { ...fitted, id: j.id, kind: merged.kind }
          }
          return merged
        })
      })
      clearPreview()
    },
    [clearPreview, baseRadius, modelSize, model],
  )

  const deleteJoint = useCallback(
    (id: number) => {
      setJoints((prev) => {
        // Delete one marker only, even if a bad save left duplicate ids.
        let hit = false
        return prev.filter((j) => {
          if (j.id !== id || hit) return true
          hit = true
          return false
        })
      })
      setSelectedId((cur) => (cur === id ? null : cur))
      clearPreview()
    },
    [clearPreview],
  )

  const clearJoints = useCallback(() => {
    setJoints([])
    nextJointId = 1
    setSelectedId(null)
    clearPreview()
    setInfoMsg('All joints cleared. Add or Auto-Suggest again.')
  }, [clearPreview])

  const handleSimplify = useCallback(async () => {
    if (!geometry || !model) return
    setBusy(true)
    setProgress(`Simplifying mesh (${simplifyStrength})…`)
    setError(null)
    try {
      await new Promise((r) => setTimeout(r, 0))
      const { geometry: simplified, before, after, watertight } = await simplifyGeometry(
        geometry,
        { strength: simplifyStrength },
      )
      if (after >= before - 100) {
        setInfoMsg(
          `Mesh is already light enough (${before.toLocaleString()} tris). Try Aggressive, or continue to Auto-Suggest.`,
        )
        return
      }
      setGeometry((prev) => {
        if (prev) disposeProbeGeometry(prev)
        prev?.dispose()
        return simplified
      })
      rebuildProbe(simplified)
      const info = infoFromGeometry(model.name, simplified)
      setModel(info)
      setCanUndoSimplify(!!originalGeoRef.current)
      clearPreview()
      const next = joints.length
        ? `Your ${joints.length} marker(s) stay where they were. Next: Preview.`
        : 'Next: Auto-Suggest Joints.'
      setInfoMsg(
        `Simplified in-app: ${before.toLocaleString()} → ${after.toLocaleString()} triangles. ${next}` +
          (watertight
            ? ''
            : ' This mesh already had holes, so it may still need repair (Blender → Make Manifold) before joints can be built.'),
      )
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Simplify failed')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [geometry, model, simplifyStrength, rebuildProbe, clearPreview, joints.length])

  const handleUndoSimplify = useCallback(() => {
    if (!originalGeoRef.current || !originalInfoRef.current) return
    const restored = originalGeoRef.current.clone()
    setGeometry((prev) => {
      if (prev) disposeProbeGeometry(prev)
      prev?.dispose()
      return restored
    })
    rebuildProbe(restored)
    setModel({ ...originalInfoRef.current })
    setCanUndoSimplify(false)
    clearPreview()
    setInfoMsg('Restored the original mesh. Your markers stay where they were.')
  }, [rebuildProbe, clearPreview])

  const handleDownloadSimplified = useCallback(() => {
    if (!geometry || !model) return
    const blob = geometryToStlBlob(geometry)
    const base = model.name.replace(/\.stl$/i, '')
    downloadBlob(blob, `${base}-simplified.stl`)
  }, [geometry, model])

  const handleSuggest = useCallback(async () => {
    if (!geometry || !model) return
    const mesh = probeRef.current ?? prepareProbeMesh(geometry)
    probeRef.current = mesh
    setBusy(true)
    setError(null)
    setInfoMsg(null)
    clearPreview()
    try {
      setProgress('Finding neck, shoulders, elbows and knees…')
      await new Promise((r) => setTimeout(r, 0))
      const hints = suggestFigureJoints(mesh, modelSize)
      if (hints.length === 0) {
        setError(
          'Couldn’t find the limbs on this model. Place joints manually with + Add.',
        )
        return
      }
      // Never touch existing markers (any kind, any settings) — only fill the
      // spots that don't have one yet.
      const nearby = modelSize * 0.06
      const added: string[] = []
      let firstSuggestedId: number | null = null
      const next = [...joints]
      for (const h of hints) {
        const taken = next.some(
          (j) => new THREE.Vector3(...j.position).distanceTo(new THREE.Vector3(...h.position)) < nearby,
        )
        if (taken) continue
        const id = allocJointId(next)
        next.push(hintToJoint(h, id, baseRadius, h.kind))
        added.push(h.name)
        firstSuggestedId ??= id
      }
      setJoints(sanitizeJoints(next))
      setSelectedId(firstSuggestedId)
      const counts = ['neck', 'shoulder', 'elbow', 'knee']
        .map((n) => [n, added.filter((a) => a === n).length] as const)
        .filter(([, c]) => c > 0)
        .map(([n, c]) => (c > 1 ? `${c} ${n}s` : n))
      setInfoMsg(
        added.length === 0
          ? 'Every joint spot already has a marker — nothing added.'
          : `Added ${counts.join(', ')}. Neck and shoulders are Ball & socket; elbows and knees are Knuckle — change any marker’s type in its panel, then Preview Split Joints.`,
      )
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Auto-suggest failed')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [geometry, model, modelSize, baseRadius, clearPreview, joints])

  // Same auto-fit the preview runs, so downloads match what you inspected
  const fitJointsForCut = useCallback(
    (input: Joint[]) => {
      if (!geometry) return input
      const mesh = probeRef.current ?? prepareProbeMesh(geometry)
      probeRef.current = mesh
      const maxScale = Math.min(3.2, (modelSize * 0.16) / Math.max(baseRadius, 1e-9))
      return clampJointScales(refitJointsToLimbs(mesh, input, baseRadius, modelSize), maxScale)
    },
    [geometry, modelSize, baseRadius],
  )

  const runCut = useCallback(async () => {
    if (!geometry || joints.length === 0) return null
    setBusy(true)
    setError(null)
    try {
      const result = await cutJointsFromModel(
        geometry,
        fitJointsForCut(joints),
        baseRadius,
        (p) => setProgress(p.label),
        filament,
      )
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cut failed'
      setError(msg)
      return null
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [geometry, joints, baseRadius, filament, fitJointsForCut])

  const previewSplit = useCallback(async () => {
    if (!geometry || joints.length === 0) return
    setBusy(true)
    setError(null)
    setInfoMsg(null)
    try {
      // Auto-fit rings to limb thickness (capped — no torso blobs)
      setProgress('Fitting joints to limb thickness…')
      await new Promise((r) => setTimeout(r, 0))
      // Allow wider kerfs for limbs fused to the torso
      const maxScale = Math.min(3.2, (modelSize * 0.16) / Math.max(baseRadius, 1e-9))
      let workingJoints = fitJointsForCut(joints)
      setJoints(workingJoints)

      let { cut, parts, warnings, notes, socketSides } = await cutAndSplitModel(
        geometry,
        workingJoints,
        baseRadius,
        (p) => setProgress(p.label),
        filament,
      )

      // At most one gentle grow — never the runaway blob loop
      if (parts.length <= 1) {
        setProgress('Growing joints slightly…')
        await new Promise((r) => setTimeout(r, 0))
        cut.dispose()
        disposeParts(parts)
        workingJoints = clampJointScales(enlargeJoints(workingJoints, 1.18, maxScale), maxScale)
        setJoints(workingJoints)
        ;({ cut, parts, warnings, notes, socketSides } = await cutAndSplitModel(
          geometry,
          workingJoints,
          baseRadius,
          (p) => setProgress(p.label),
          filament,
        ))
      }
      const built: BuiltSides = {}
      for (const j of workingJoints) {
        const side = socketSides?.[j.id]
        if (side) built[j.id] = { key: socketSideKey(j), side }
      }
      setBuiltSides(built)

      setPreviewCut((prev) => {
        prev?.dispose()
        return cut
      })
      setPreviewParts((prev) => {
        disposeParts(prev)
        return parts
      })
      setExplode(0.55)
      setPlacing(false)
      setSelectedId(null)

      if (parts.length <= 1) {
        setError(
          'Still one body after auto-sizing. Check each joint’s Cut Axis (should run along the limb), or move the marker to the middle of the limb connection — then Preview again.',
        )
      } else if (warnings.length > 0) {
        setError(`Preview ready — ${parts.length} parts, but:\n• ${warnings.join('\n• ')}`)
        if (notes.length) setInfoMsg(notes.join(' '))
      } else {
        setInfoMsg(
          notes.length
            ? `Preview ready — ${parts.length} body parts. ${notes.join(' ')}`
            : `Preview ready — ${parts.length} body part(s). Use Explode to inspect, then download.`,
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cut failed'
      setError(msg)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [geometry, joints, baseRadius, modelSize, filament, fitJointsForCut])

  const exportCut = useCallback(async () => {
    let result = previewCut
    let shouldDispose = false
    if (!result) {
      result = await runCut()
      shouldDispose = true
    }
    if (!result || !model) return
    const blob = geometryToStlBlob(result)
    const base = model.name.replace(/\.stl$/i, '')
    downloadBlob(blob, `${base}-articulated.stl`)
    if (shouldDispose) result.dispose()
  }, [previewCut, runCut, model])

  const exportParts = useCallback(async () => {
    let parts = previewParts
    let owned = false
    if (!parts) {
      if (!geometry || joints.length === 0 || !model) return
      setBusy(true)
      setError(null)
      try {
        const result = await cutAndSplitModel(
          geometry,
          fitJointsForCut(joints),
          baseRadius,
          (p) => setProgress(p.label),
          filament,
        )
        parts = result.parts
        result.cut.dispose()
        owned = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Cut failed'
        setError(msg)
        return
      } finally {
        setBusy(false)
        setProgress(null)
      }
    }
    if (!parts || !model) return
    const base = model.name.replace(/\.stl$/i, '')
    const files = [
      ...parts.map((geometry, i) => ({
        name: `${base}-part-${i + 1}.stl`,
        geometry,
      })),
    ]
    await downloadStlZip(files, `${base}-parts.zip`)
    setInfoMsg(`Downloaded ${base}-parts.zip — ${parts.length} body part(s) with joint hardware.`)
    if (owned) {
      disposeParts(parts)
    }
  }, [
    previewParts,
    geometry,
    joints,
    baseRadius,
    model,
    filament,
    fitJointsForCut,
  ])

  const exportCutters = useCallback(async () => {
    if (!model || joints.length === 0) return
    const unit = createCutterGeometry(1, 1)
    const base = model.name.replace(/\.stl$/i, '')
    const files = joints.map((joint, i) => {
      const mesh = new THREE.Mesh(unit.clone())
      applyJointTransform(mesh, joint, 1)
      mesh.scale.setScalar(baseRadius * Math.max(joint.scale, 0.05))
      mesh.updateMatrix()
      const baked = unit.clone()
      baked.applyMatrix4(mesh.matrix)
      return { name: `${base}-cutter-${i + 1}.stl`, geometry: baked }
    })
    unit.dispose()
    await downloadStlZip(files, `${base}-cutters.zip`)
    for (const f of files) f.geometry.dispose()
  }, [model, joints, baseRadius])

  const exportBallHardware = useCallback(async () => {
    if (!model || joints.length === 0) return
    const ballJoints = joints.filter((j) => normalizeJointKind(j.kind) === 'ball')
    if (ballJoints.length === 0) {
      setError(
        'No ball & socket markers to export. Hinge / knuckle / swivel / universal use their own test downloads.',
      )
      return
    }
    const base = model.name.replace(/\.stl$/i, '')
    const files = ballJoints.map((joint, i) => ({
      name: `${base}-ball-joint-${i + 1}.stl`,
      geometry: createBallHardwareGeometry(baseRadius, joint),
    }))
    await downloadStlZip(files, `${base}-ball-joints.zip`)
    for (const f of files) f.geometry.dispose()
    const skipped = joints.length - ballJoints.length
    setInfoMsg(
      skipped > 0
        ? `Downloaded ${ballJoints.length} ball joint(s). Left ${skipped} non-ball marker(s) alone.`
        : `Downloaded ${ballJoints.length} printable ball joint(s). Print those separately and snap into the sockets on your body parts.`,
    )
  }, [model, joints, baseRadius])

  return (
    <div className="app">
      <Sidebar
        model={model}
        joints={joints}
        selectedId={selectedId}
        placing={placing}
        baseRadius={baseRadius}
        busy={busy}
        progress={progress}
        previewing={previewParts !== null}
        previewPartCount={previewParts?.length ?? 0}
        explode={explode}
        onLoadFile={handleLoad}
        onClearModel={clearModel}
        onTogglePlace={() => {
          clearPreview()
          setPlacing((p) => !p)
        }}
        onSelectJoint={setSelectedId}
        onUpdateJoint={updateJoint}
        onDeleteJoint={deleteJoint}
        onClearJoints={clearJoints}
        filament={filament}
        onFilamentChange={setFilamentAndPersist}
        jointKind={jointKind}
        onJointKindChange={setJointKindAndPersist}
        simplifyStrength={simplifyStrength}
        canUndoSimplify={canUndoSimplify}
        onSimplifyStrengthChange={setSimplifyStrength}
        onSimplify={handleSimplify}
        onUndoSimplify={handleUndoSimplify}
        onDownloadSimplified={handleDownloadSimplified}
        onSuggestJoints={handleSuggest}
        onPreviewSplit={previewSplit}
        onClearPreview={clearPreview}
        onExplodeChange={setExplode}
        onExportCut={exportCut}
        onExportCutters={exportCutters}
        onExportBallHardware={exportBallHardware}
        onExportParts={exportParts}
      />
      <Viewport
        geometry={geometry}
        previewParts={previewParts}
        explode={explode}
        joints={joints}
        socketSides={socketSides}
        selectedId={selectedId}
        baseRadius={baseRadius}
        placing={placing}
        onSelectJoint={setSelectedId}
        onUpdateJoint={updateJoint}
        onPlaceJoint={placeJoint}
      />
      {error && (
        <div className="toast error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {infoMsg && !error && (
        <div className="toast info" role="status">
          <span>{infoMsg}</span>
          <button type="button" onClick={() => setInfoMsg(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <div className="build-tag">auto-suggest · simplify · local-size</div>
    </div>
  )
}
