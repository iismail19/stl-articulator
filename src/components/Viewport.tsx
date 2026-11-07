import { OrbitControls } from '@react-three/drei'
import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber'
import { Suspense, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { SocketSide } from '../lib/hostSide'
import type { Joint } from '../types'
import { JointMarkers } from './JointMarkers'
import { PreviewParts } from './PreviewParts'

interface ViewportProps {
  geometry: THREE.BufferGeometry | null
  previewParts: THREE.BufferGeometry[] | null
  explode: number
  joints: Joint[]
  socketSides: Record<number, SocketSide>
  selectedId: number | null
  baseRadius: number
  placing: boolean
  onSelectJoint: (id: number | null) => void
  onUpdateJoint: (id: number, patch: Partial<Joint>) => void
  onPlaceJoint: (point: THREE.Vector3, normal: THREE.Vector3) => void
}

function FitCamera({ geometry }: { geometry: THREE.BufferGeometry }) {
  const { camera, controls } = useThree()

  useEffect(() => {
    geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere
    if (!sphere) return

    const persp = camera as THREE.PerspectiveCamera
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2))
    const dir = new THREE.Vector3(1.2, 0.9, 1.5).normalize()
    persp.position.copy(dir.multiplyScalar(dist * 1.15).add(sphere.center))
    persp.near = Math.max(dist / 200, 0.0001)
    persp.far = dist * 20
    persp.updateProjectionMatrix()
    persp.lookAt(sphere.center)

    const orbit = controls as unknown as { target: THREE.Vector3; update: () => void } | null
    if (orbit?.target) {
      orbit.target.copy(sphere.center)
      orbit.update()
    }
  }, [geometry, camera, controls])

  return null
}

function FitPreviewCamera({ parts }: { parts: THREE.BufferGeometry[] }) {
  const merged = useMemo(() => {
    // Use largest part's sphere expanded — good enough for framing
    const box = new THREE.Box3()
    for (const g of parts) {
      g.computeBoundingBox()
      if (g.boundingBox) box.union(g.boundingBox)
    }
    const sphere = new THREE.Sphere()
    box.getBoundingSphere(sphere)
    // Room for explode
    sphere.radius *= 1.6
    const geo = new THREE.BufferGeometry()
    geo.boundingSphere = sphere
    return geo
  }, [parts])

  return <FitCamera geometry={merged} />
}

function ModelMesh({
  geometry,
  placing,
  onPlace,
  onDeselect,
}: {
  geometry: THREE.BufferGeometry
  placing: boolean
  onPlace: (point: THREE.Vector3, normal: THREE.Vector3) => void
  onDeselect: () => void
}) {
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#94a3b8',
        metalness: 0.15,
        roughness: 0.55,
      }),
    [],
  )

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (placing) {
      const normal = e.face?.normal
        ? e.face.normal.clone().transformDirection(e.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0)
      onPlace(e.point.clone(), normal)
    } else {
      onDeselect()
    }
  }

  return (
    <mesh
      geometry={geometry}
      material={material}
      onClick={handleClick}
      onPointerOver={() => {
        document.body.style.cursor = placing ? 'crosshair' : 'grab'
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto'
      }}
    />
  )
}

export function Viewport({
  geometry,
  previewParts,
  explode,
  joints,
  socketSides,
  selectedId,
  baseRadius,
  placing,
  onSelectJoint,
  onUpdateJoint,
  onPlaceJoint,
}: ViewportProps) {
  const previewing = previewParts !== null && previewParts.length > 0

  return (
    <div className={`viewport ${placing ? 'placing' : ''} ${previewing ? 'previewing' : ''}`}>
      <Canvas
        camera={{ position: [2.2, 1.6, 2.8], fov: 40, near: 0.001, far: 5000 }}
        gl={{ antialias: true }}
        onPointerMissed={() => {
          if (!placing && !previewing) onSelectJoint(null)
        }}
      >
        <color attach="background" args={['#0f1419']} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[4, 8, 5]} intensity={1.15} />
        <directionalLight position={[-3, 2, -4]} intensity={0.4} />
        <Suspense fallback={null}>
          {previewing ? (
            <>
              <FitPreviewCamera parts={previewParts} />
              <PreviewParts parts={previewParts} explode={explode} />
            </>
          ) : (
            geometry && (
              <>
                <FitCamera geometry={geometry} />
                <ModelMesh
                  geometry={geometry}
                  placing={placing}
                  onPlace={onPlaceJoint}
                  onDeselect={() => onSelectJoint(null)}
                />
                <JointMarkers
                  joints={joints}
                  socketSides={socketSides}
                  selectedId={selectedId}
                  baseRadius={baseRadius}
                  onSelect={onSelectJoint}
                  onChange={onUpdateJoint}
                />
              </>
            )
          )}
        </Suspense>
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
        <gridHelper args={[2, 20, '#1e293b', '#151b24']} position={[0, -0.001, 0]} />
      </Canvas>

      {!geometry && (
        <div className="viewport-empty">
          <p>Upload an STL to get started</p>
          <span>Then click Place Joint and pick spots on the model</span>
        </div>
      )}

      {placing && geometry && !previewing && (
        <div className="place-banner">Click the model to place a joint · Esc to cancel</div>
      )}

      {previewing && (
        <div className="place-banner preview-banner">
          Preview — {previewParts.length} body part{previewParts.length === 1 ? '' : 's'} ·
          drag to orbit · Explode to separate
        </div>
      )}
    </div>
  )
}
