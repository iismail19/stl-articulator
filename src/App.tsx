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
import { applyJointTransform, createCutterGeometry } from './lib/cutterGeometry'
import {
  disposeProbeGeometry,
  enlargeJoints,
  hintToJoint,
  prepareProbeMesh,
  probeJointAtPoint,
  clampJointScales,
  refitJointsToLimbs,
  suggestJoints,
  type ProbeMesh,
} from './lib/meshProbe'
import { simplifyGeometry, type SimplifyStrength } from './lib/simplifyMesh'
import {
  downloadBlob,
  downloadStlZip,
  geometryToStlBlob,
  loadStlFile,
  suggestBaseRadius,
} from './lib/stlIO'
import type { FilamentType, Joint, ModelInfo } from './types'
import './App.css'

let nextJointId = 1

// v2: joints stay on the cut (old saves recentered into limbs and broke sockets)
const JOINTS_KEY = (name: string) => `stl-articulator-joints:v2:${name}`

function loadSavedJoints(modelName: string): Joint[] | null {
  try {
    const raw = localStorage.getItem(JOINTS_KEY(modelName))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Joint[]
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return parsed.map((j, i) => ({
      id: typeof j.id === 'number' ? j.id : i + 1,
      position: j.position,
      axis: j.axis === 'x' || j.axis === 'z' ? j.axis : 'y',
      scale: typeof j.scale === 'number' ? j.scale : 1,
      rotation: typeof j.rotation === 'number' ? j.rotation : 0,
      tilt: Array.isArray(j.tilt) ? j.tilt : [0, 0, 0],
    }))
  } catch {
    return null
  }
}

function saveJoints(modelName: string, joints: Joint[]) {
  try {
    if (joints.length === 0) localStorage.removeItem(JOINTS_KEY(modelName))
    else localStorage.setItem(JOINTS_KEY(modelName), JSON.stringify(joints))
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
        `Filament set to ${getFilamentProfile(next).label} — re-run Preview to rebuild joints.`,
      )
    },
    [clearPreview],
  )

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
    setSelectedId(null)
    setPlacing(false)
  }, [clearPreview])

  const placeJoint = useCallback(
    (point: THREE.Vector3, normal: THREE.Vector3) => {
      const mesh = probeRef.current ?? (geometry ? prepareProbeMesh(geometry) : null)
      if (mesh) probeRef.current = mesh
      let joint: Joint
      if (mesh && model) {
        const hint = probeJointAtPoint(mesh, point, normal, modelSize)
        joint = hintToJoint(hint, nextJointId++, baseRadius)
      } else {
        joint = {
          id: nextJointId++,
          position: [point.x, point.y, point.z],
          axis: 'y',
          scale: 1,
          rotation: 0,
          tilt: [0, 0, 0],
        }
      }
      setJoints((prev) => [...prev, joint])
      setSelectedId(joint.id)
      setPlacing(false)
      clearPreview()
      setError(null)
      setInfoMsg(
        `Joint #${joint.id} placed & centered. Aim the white arrow along the limb (Cut Axis + Tilt X/Y/Z). For wrists/ankles, click the thin middle, then nudge tilt until parts look flush.`,
      )
    },
    [baseRadius, model, modelSize, geometry, clearPreview],
  )

  const updateJoint = useCallback(
    (id: number, patch: Partial<Joint>) => {
      setJoints((prev) =>
        prev.map((j) => {
          if (j.id !== id) return j
          const merged = { ...j, ...patch }
          // Re-auto-size when moved or axis changed (click-and-go UX)
          const moved =
            patch.position != null || patch.axis != null
          if (moved && probeRef.current) {
            const [fitted] = refitJointsToLimbs(
              probeRef.current,
              [merged],
              baseRadius,
              modelSize,
            )
            return fitted
          }
          return merged
        }),
      )
      clearPreview()
    },
    [clearPreview, baseRadius, modelSize],
  )

  const deleteJoint = useCallback(
    (id: number) => {
      setJoints((prev) => prev.filter((j) => j.id !== id))
      setSelectedId((cur) => (cur === id ? null : cur))
      clearPreview()
    },
    [clearPreview],
  )

  const clearJoints = useCallback(() => {
    setJoints([])
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
      const { geometry: simplified, before, after } = await simplifyGeometry(
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
      setJoints([])
      setSelectedId(null)
      nextJointId = 1
      setInfoMsg(
        `Simplified in-app: ${before.toLocaleString()} → ${after.toLocaleString()} triangles. Next: Auto-Suggest Joints.`,
      )
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Simplify failed')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [geometry, model, simplifyStrength, rebuildProbe, clearPreview])

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
    setJoints([])
    setSelectedId(null)
    nextJointId = 1
    setInfoMsg('Restored original unsimplified mesh.')
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
      const hints = await suggestJoints(mesh, modelSize, {
        maxJoints: 14,
        onProgress: (label) => setProgress(label),
      })
      if (hints.length === 0) {
        setError(
          'Couldn’t find clear narrow spots. Try Simplify Mesh first, or place joints manually (+ Add).',
        )
        return
      }
      const next = hints.map((h) => hintToJoint(h, nextJointId++, baseRadius))
      setJoints(next)
      setSelectedId(next[0]?.id ?? null)
      setInfoMsg(
        `Suggested ${next.length} joints at narrow cross-sections. Delete any that look wrong, then Preview Split Joints.`,
      )
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Auto-suggest failed')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [geometry, model, modelSize, baseRadius, clearPreview])

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

      let { cut, parts, warnings } = await cutAndSplitModel(
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
        ;({ cut, parts, warnings } = await cutAndSplitModel(
          geometry,
          workingJoints,
          baseRadius,
          (p) => setProgress(p.label),
          filament,
        ))
      }

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
      } else {
        setInfoMsg(
          `Preview ready — ${parts.length} parts with ball↔socket at each joint. Use Explode to inspect.`,
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
    await downloadStlZip(
      parts.map((geometry, i) => ({ name: `${base}-part-${i + 1}.stl`, geometry })),
      `${base}-parts.zip`,
    )
    setInfoMsg(`Downloaded ${base}-parts.zip — ${parts.length} part STLs with balls & sockets.`)
    if (owned) disposeParts(parts)
  }, [previewParts, geometry, joints, baseRadius, model, filament, fitJointsForCut])

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
    const base = model.name.replace(/\.stl$/i, '')
    const files = joints.map((joint, i) => ({
      name: `${base}-ball-joint-${i + 1}.stl`,
      geometry: createBallHardwareGeometry(baseRadius, joint),
    }))
    await downloadStlZip(files, `${base}-ball-joints.zip`)
    for (const f of files) f.geometry.dispose()
    setInfoMsg(
      `Downloaded ${joints.length} printable ball joint(s). Print those separately and snap into the sockets on your body parts.`,
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
