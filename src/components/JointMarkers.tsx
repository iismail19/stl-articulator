import { TransformControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { jointLocalToWorld, jointStemQuaternion, ringQuaternion } from '../lib/cutterGeometry'
import type { SocketSide } from '../lib/hostSide'
import { bendsOnOneAxis } from '../lib/jointKinds'
import type { Joint } from '../types'

interface JointMarkersProps {
  joints: Joint[]
  socketSides: Record<number, SocketSide>
  selectedId: number | null
  baseRadius: number
  onSelect: (id: number) => void
  onChange: (id: number, patch: Partial<Joint>) => void
}

function JointMarker({
  joint,
  side,
  selected,
  baseRadius,
  onSelect,
  onChange,
}: {
  joint: Joint
  side: SocketSide
  selected: boolean
  baseRadius: number
  onSelect: () => void
  onChange: (patch: Partial<Joint>) => void
}) {
  const groupRef = useRef<THREE.Group>(null)
  const { gl } = useThree()
  const radius = baseRadius * Math.max(joint.scale, 0.05)
  const stemQ = jointStemQuaternion(joint)
  const ringQ = ringQuaternion(joint)
  const isHinge = bendsOnOneAxis(joint.kind)
  // Cylinder geometry runs along +Y, same as the hinge axis in the cut frame.
  const hingeQ = new THREE.Quaternion().setFromRotationMatrix(jointLocalToWorld(joint))

  useLayoutEffect(() => {
    if (groupRef.current) {
      groupRef.current.position.set(...joint.position)
    }
  }, [joint.position])

  return (
    <group>
      <group
        ref={groupRef}
        position={joint.position}
        onClick={(e) => {
          e.stopPropagation()
          onSelect()
        }}
      >
        {/* Kerf plane ring */}
        <mesh quaternion={ringQ} scale={radius}>
          <torusGeometry args={[1, 0.08, 12, 48]} />
          <meshStandardMaterial
            color={selected ? '#3b82f6' : '#f97316'}
            transparent
            opacity={0.55}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>

        {/* Twist tick on the ring — makes Rotation slider visible */}
        <group quaternion={ringQ} scale={radius}>
          <mesh position={[1.05, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <coneGeometry args={[0.12, 0.35, 8]} />
            <meshStandardMaterial
              color={selected ? '#93c5fd' : '#fdba74'}
              transparent
              opacity={0.9}
              depthWrite={false}
            />
          </mesh>
        </group>

        {isHinge && (
          // Pivot bar — the hinge peg runs along this; the limb swings around it.
          <mesh quaternion={hingeQ} scale={radius}>
            <cylinderGeometry args={[0.1, 0.1, 2.8, 12]} />
            <meshStandardMaterial color={selected ? '#fde68a' : '#facc15'} />
          </mesh>
        )}

        {/* Stem + ball along cut axis (includes X/Y/Z tilt). The ball reaches into
            the socket part, so it's drawn on that side; the arrow takes the other. */}
        <group quaternion={stemQ} scale={radius}>
          <mesh position={[0, 0.85 * side, 0]} renderOrder={2}>
            <sphereGeometry args={[0.55, 20, 14]} />
            <meshStandardMaterial
              color={selected ? '#60a5fa' : '#fb923c'}
              transparent
              opacity={0.4}
              depthWrite={false}
              depthTest={false}
            />
          </mesh>
          <mesh position={[0, 0.42 * side, 0]} renderOrder={2}>
            <cylinderGeometry args={[0.22, 0.22, 0.85, 14]} />
            <meshStandardMaterial
              color={selected ? '#60a5fa' : '#fb923c'}
              transparent
              opacity={0.35}
              depthWrite={false}
              depthTest={false}
            />
          </mesh>
          {/* Axis arrow — aim this along the limb */}
          <group rotation={[side > 0 ? Math.PI : 0, 0, 0]}>
            <mesh position={[0, 0.55, 0]}>
              <cylinderGeometry args={[0.06, 0.06, 0.7, 8]} />
              <meshStandardMaterial color={selected ? '#e2e8f0' : '#94a3b8'} />
            </mesh>
            <mesh position={[0, 1.0, 0]}>
              <coneGeometry args={[0.14, 0.28, 8]} />
              <meshStandardMaterial color={selected ? '#f8fafc' : '#cbd5e1'} />
            </mesh>
          </group>
        </group>
      </group>

      {selected && groupRef.current && (
        <TransformControls
          object={groupRef.current}
          mode="translate"
          size={0.65}
          onMouseDown={() => {
            gl.domElement.style.cursor = 'grabbing'
          }}
          onMouseUp={() => {
            gl.domElement.style.cursor = 'auto'
          }}
          onObjectChange={() => {
            const p = groupRef.current!.position
            onChange({ position: [p.x, p.y, p.z] })
          }}
        />
      )}
    </group>
  )
}

export function JointMarkers({
  joints,
  socketSides,
  selectedId,
  baseRadius,
  onSelect,
  onChange,
}: JointMarkersProps) {
  return (
    <>
      {joints.map((joint, index) => (
        <JointMarker
          // Unique id is required. Index is a last-resort suffix if a bad save
          // left duplicate ids so React never merges two markers into one.
          key={`joint-${joint.id}-${index}`}
          joint={joint}
          side={socketSides[joint.id] ?? -1}
          selected={joint.id === selectedId}
          baseRadius={baseRadius}
          onSelect={() => onSelect(joint.id)}
          onChange={(patch) => onChange(joint.id, patch)}
        />
      ))}
    </>
  )
}
