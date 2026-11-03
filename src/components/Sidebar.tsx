import type { SimplifyStrength } from '../lib/simplifyMesh'
import {
  FILAMENT_PROFILES,
  type FilamentType,
} from '../lib/filamentProfiles'
import type { CutAxis, Joint, ModelInfo } from '../types'
import { formatSize } from '../lib/stlIO'

interface SidebarProps {
  model: ModelInfo | null
  joints: Joint[]
  selectedId: number | null
  placing: boolean
  baseRadius: number
  busy: boolean
  progress: string | null
  previewing: boolean
  previewPartCount: number
  explode: number
  filament: FilamentType
  onFilamentChange: (f: FilamentType) => void
  simplifyStrength: SimplifyStrength
  canUndoSimplify: boolean
  onLoadFile: (file: File) => void
  onClearModel: () => void
  onTogglePlace: () => void
  onSelectJoint: (id: number) => void
  onUpdateJoint: (id: number, patch: Partial<Joint>) => void
  onDeleteJoint: (id: number) => void
  onClearJoints: () => void
  onSimplifyStrengthChange: (s: SimplifyStrength) => void
  onSimplify: () => void
  onUndoSimplify: () => void
  onDownloadSimplified: () => void
  onSuggestJoints: () => void
  onPreviewSplit: () => void
  onClearPreview: () => void
  onExplodeChange: (v: number) => void
  onExportCut: () => void
  onExportCutters: () => void
  onExportBallHardware: () => void
  onExportParts: () => void
}

function AxisButtons({
  value,
  onChange,
}: {
  value: CutAxis
  onChange: (a: CutAxis) => void
}) {
  return (
    <div className="axis-row">
      {(['x', 'y', 'z'] as CutAxis[]).map((a) => (
        <button
          key={a}
          type="button"
          className={`axis-btn ${value === a ? 'active' : ''}`}
          onClick={() => onChange(a)}
        >
          {a.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

export function Sidebar({
  model,
  joints,
  selectedId,
  placing,
  baseRadius,
  busy,
  progress,
  previewing,
  previewPartCount,
  explode,
  filament,
  onFilamentChange,
  onLoadFile,
  onClearModel,
  onTogglePlace,
  onSelectJoint,
  onUpdateJoint,
  onDeleteJoint,
  onClearJoints,
  simplifyStrength,
  canUndoSimplify,
  onSimplifyStrengthChange,
  onSimplify,
  onUndoSimplify,
  onDownloadSimplified,
  onSuggestJoints,
  onPreviewSplit,
  onClearPreview,
  onExplodeChange,
  onExportCut,
  onExportCutters,
  onExportBallHardware,
  onExportParts,
}: SidebarProps) {
  const selected = joints.find((j) => j.id === selectedId) ?? null
  const absoluteScaleMm = baseRadius * (selected?.scale ?? 1)

  return (
    <aside className="sidebar">
      <header className="sidebar-brand">
        <h1>STL Articulator</h1>
        <p>Auto-suggest joints · preview · snap-print</p>
      </header>

      <section className="panel steps-panel">
        <h2>How to use</h2>
        <ol className="steps">
          <li className={model ? 'done' : ''}>Upload STL</li>
          <li className={model && model.triangles > 150_000 ? 'highlight' : ''}>
            Optional: Simplify if the mesh is huge
          </li>
          <li className={joints.length > 0 ? 'done' : 'highlight'}>
            + Add → click a joint spot (size is automatic)
          </li>
          <li className={previewing ? 'done' : ''}>Preview Split Joints</li>
          <li className={previewing ? 'highlight' : ''}>Download parts + ball joints</li>
        </ol>
        <p className="muted" style={{ marginTop: '0.35rem' }}>
          You only pick the point. The orange ring auto-sizes to that limb.
        </p>
      </section>

      <section className="panel filament-panel">
        <h2>Filament</h2>
        <p className="muted">
          Sets snap tightness so joints don’t crack on first insert.
        </p>
        <div className="axis-row filament-row">
          {(Object.keys(FILAMENT_PROFILES) as FilamentType[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`axis-btn ${filament === id ? 'active' : ''}`}
              onClick={() => onFilamentChange(id)}
            >
              {FILAMENT_PROFILES[id].label}
            </button>
          ))}
        </div>
        <p className="filament-hint">{FILAMENT_PROFILES[filament].hint}</p>
        <p className="muted" style={{ marginTop: '0.55rem' }}>
          Print-tested PLA pair (Ø8 mm) — model joints use these same snap settings:
        </p>
        <div className="btn-row">
          <a
            className="btn btn-ghost btn-sm"
            href="/test-joints/pla-ball-stem-v10.stl"
            download
          >
            Ball + stem
          </a>
          <a className="btn btn-ghost btn-sm" href="/test-joints/pla-socket-v10.stl" download>
            Socket
          </a>
        </div>
      </section>

      <section className="panel">
        <h2>Model</h2>
        {model ? (
          <>
            <div className="meta">
              <div>
                <span className="label">File</span>
                <strong title={model.name}>{model.name}</strong>
              </div>
              <div>
                <span className="label">Size</span>
                <strong>{formatSize(model.size)}</strong>
              </div>
              <div>
                <span className="label">Triangles</span>
                <strong>{model.triangles.toLocaleString()}</strong>
              </div>
            </div>
            <label className="btn btn-ghost file-btn">
              Load Different Model
              <input
                type="file"
                accept=".stl,model/stl"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onLoadFile(f)
                  e.target.value = ''
                }}
              />
            </label>
            <button type="button" className="btn btn-ghost" onClick={onClearModel}>
              Clear
            </button>
          </>
        ) : (
          <label className="btn btn-primary file-btn">
            Upload STL
            <input
              type="file"
              accept=".stl,model/stl"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onLoadFile(f)
                e.target.value = ''
              }}
            />
          </label>
        )}
      </section>

      {model && !previewing && (
        <section className="panel simplify-panel">
          <h2>Simplify Mesh</h2>
          <p className="muted">
            Reduce triangles in-browser so cuts succeed — no Blender required.
            {model.triangles > 150_000 ? ' This mesh is dense; simplify first.' : ''}
          </p>
          {model.triangles > 150_000 && (
            <p className="warn">
              {model.triangles.toLocaleString()} triangles — recommended before Auto-Suggest /
              Preview.
            </p>
          )}
          <div className="axis-row">
            {(
              [
                ['light', 'Light'],
                ['medium', 'Medium'],
                ['aggressive', 'Aggressive'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`axis-btn ${simplifyStrength === value ? 'active' : ''}`}
                onClick={() => onSimplifyStrengthChange(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-simplify"
            disabled={busy}
            onClick={onSimplify}
          >
            {busy && progress?.toLowerCase().includes('simplif')
              ? progress
              : 'Simplify Mesh'}
          </button>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!canUndoSimplify || busy}
              onClick={onUndoSimplify}
            >
              Undo Simplify
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={onDownloadSimplified}
            >
              Download STL
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Joints ({joints.length})</h2>
          <button
            type="button"
            className={`btn btn-sm ${placing ? 'btn-accent' : 'btn-primary'}`}
            disabled={!model || busy || previewing}
            onClick={onTogglePlace}
          >
            {placing ? 'Cancel' : '+ Add'}
          </button>
        </div>

        {previewing && (
          <p className="warn">
            Preview is on — change Cut Axis / Twist below to edit (preview will clear), or
            press Clear Preview.
          </p>
        )}

        <p className="muted">
          Click <strong>+ Add</strong>, then click the model at a shoulder, elbow, hip, or
          knee. Size is automatic — you don’t set scale.
        </p>
        <button
          type="button"
          className="btn btn-suggest"
          disabled={!model || busy || previewing}
          onClick={onSuggestJoints}
        >
          {busy && progress?.includes('Scanning')
            ? progress
            : '✨ Auto-Suggest (optional)'}
        </button>
        {joints.length > 0 && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={onClearJoints}
            style={{ marginTop: 8 }}
          >
            Clear All Joints ({joints.length})
          </button>
        )}

        {joints.length === 0 ? (
          <p className="muted">No joints yet — click + Add, then click a limb joint.</p>
        ) : (
          <ul className="joint-list">
            {joints.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  className={`joint-card ${j.id === selectedId ? 'selected' : ''}`}
                  onClick={() => onSelectJoint(j.id)}
                >
                  <span className="joint-title">
                    Joint #{j.id}{' '}
                    <em className="axis-tag">{j.axis.toUpperCase()}</em>
                  </span>
                  <span className="joint-coords">
                    auto-sized · {j.axis.toUpperCase()} · twist{' '}
                    {j.rotation.toFixed(0)}°
                    {(j.tilt ?? [0, 0, 0]).some((t) => t !== 0)
                      ? ` · tilt ${(j.tilt ?? [0, 0, 0]).map((t) => t.toFixed(0)).join('/')}`
                      : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section className="panel">
          <h2>Joint #{selected.id}</h2>
          <p className="muted success-note">
            Auto-sized to this limb (r≈{absoluteScaleMm.toFixed(3)}). Drag the gizmo to
            move — size updates automatically.
          </p>

          <p className="muted" style={{ marginTop: 0 }}>
            STLs are Z-up: the neck is Axis <strong>Z</strong> (socket goes in the head).
            Shoulders are usually Axis <strong>X</strong>; elbows on hanging arms are Axis{' '}
            <strong>Z</strong>. Add a little Tilt so the arrow follows the limb. Wrists/ankles:
            click the thin middle, Recenter if off, then Tilt until the cut looks square to the
            limb.
          </p>

          <label className="field">
            <span>Cut Axis — aims the white arrow along the limb</span>
            <AxisButtons
              value={selected.axis}
              onChange={(axis) => onUpdateJoint(selected.id, { axis })}
            />
          </label>

          <fieldset className="field">
            <legend>
              Tilt X / Y / Z —{' '}
              {(selected.tilt ?? [0, 0, 0]).map((t) => `${t.toFixed(0)}°`).join(' · ')}
            </legend>
            <div className="xyz tilt-sliders">
              {(['X', 'Y', 'Z'] as const).map((label, i) => (
                <label key={label}>
                  <span>{label}</span>
                  <input
                    type="range"
                    min={-60}
                    max={60}
                    step={1}
                    value={(selected.tilt ?? [0, 0, 0])[i]}
                    onChange={(e) => {
                      const next = [...(selected.tilt ?? [0, 0, 0])] as [
                        number,
                        number,
                        number,
                      ]
                      next[i] = parseFloat(e.target.value)
                      onUpdateJoint(selected.id, { tilt: next })
                    }}
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onUpdateJoint(selected.id, { tilt: [0, 0, 0] })}
            >
              Reset tilt
            </button>
          </fieldset>

          <label className="field">
            <span>Twist around axis — {selected.rotation.toFixed(0)}° (moves the orange tick)</span>
            <input
              type="range"
              min={0}
              max={360}
              step={1}
              value={selected.rotation}
              onChange={(e) =>
                onUpdateJoint(selected.id, { rotation: parseFloat(e.target.value) })
              }
            />
          </label>

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                onUpdateJoint(selected.id, {
                  rotation: (selected.rotation + 180) % 360,
                })
              }
            >
              Flip 180°
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                onUpdateJoint(selected.id, {
                  position: [...selected.position] as [number, number, number],
                })
              }
              title="Re-run limb centering at the current spot"
            >
              Recenter
            </button>
          </div>

          <button
            type="button"
            className="btn btn-danger"
            onClick={() => onDeleteJoint(selected.id)}
          >
            Delete Joint
          </button>

          <details className="advanced">
            <summary>Advanced (optional)</summary>
            <fieldset className="field">
              <legend>Position</legend>
              <div className="xyz">
                {(['x', 'y', 'z'] as const).map((axis, i) => (
                  <label key={axis}>
                    <span>{axis.toUpperCase()}</span>
                    <input
                      type="number"
                      step="0.01"
                      value={Number(selected.position[i].toFixed(4))}
                      onChange={(e) => {
                        const next = [...selected.position] as [number, number, number]
                        next[i] = parseFloat(e.target.value) || 0
                        onUpdateJoint(selected.id, { position: next })
                      }}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="field">
              <span>Manual scale override — {(selected.scale * 100).toFixed(0)}%</span>
              <input
                type="range"
                min={0.25}
                max={5}
                step={0.01}
                value={selected.scale}
                onChange={(e) =>
                  onUpdateJoint(selected.id, { scale: parseFloat(e.target.value) })
                }
              />
            </label>
          </details>
        </section>
      )}

      <section className="panel export-panel">
        <h2>{previewing ? 'Preview ready' : 'Preview & download'}</h2>

        <p className="muted what-it-does">
          <strong>What this does:</strong> at each marker, severs <em>only that joint</em>,
          then puts a <em>ball on one part</em> and a <em>socket on the other</em>. You should
          get a few body parts (arms/legs/torso) — not wafer slices. Place on shoulders,
          elbows, hips, knees.
        </p>

        {previewing ? (
          <>
            <p className="muted success-note">
              {previewPartCount} colored part{previewPartCount === 1 ? '' : 's'} in the 3D
              view. Explode to see cut faces.
              {previewPartCount <= 1
                ? ' Still one piece — enlarge Scale or check cut axis.'
                : ''}
            </p>
            <label className="field">
              <span>Explode — {(explode * 100).toFixed(0)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={explode}
                onChange={(e) => onExplodeChange(parseFloat(e.target.value))}
              />
            </label>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={onClearPreview}
            >
              ← Back to editing
            </button>
            <button
              type="button"
              className="btn btn-success"
              disabled={busy || previewPartCount <= 1}
              onClick={onExportParts}
            >
              Download Separate Body Parts
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || joints.length === 0}
              onClick={onExportBallHardware}
            >
              Download Ball Joints (print & snap in)
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={onExportCut}
            >
              Download Combined Cut Model
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-success btn-preview"
              disabled={!model || joints.length === 0 || busy}
              onClick={onPreviewSplit}
            >
              {busy && !progress?.includes('Scanning') && !progress?.toLowerCase().includes('simplif')
                ? progress ?? 'Working…'
                : '▶ Preview Split Joints'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!model || joints.length === 0 || busy}
              onClick={onExportBallHardware}
            >
              Download Ball Joints Only
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!model || joints.length === 0 || busy}
              onClick={onExportCutters}
            >
              Download Cutters Only
            </button>
          </>
        )}
        {progress && busy && <p className="progress">{progress}</p>}
      </section>
    </aside>
  )
}
