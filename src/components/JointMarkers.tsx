import { TransformControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { jointStemQuaternion, ringQuaternion } from '../lib/cutterGeometry'
import type { Joint } from '../types'

interface JointMarkersProps {
  joints: Joint[]
  selectedId: number | null
  baseRadius: number
  onSelect: (id: number) => void
  onChange: (id: number, patch: Partial<Joint>) => void
}

function JointMarker({
  joint,
  selected,
  baseRadius,
  onSelect,
  onChange,
}: {
  joint: Joint
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

        {/* Stem + ball along cut axis (includes X/Y/Z tilt) */}
        <group quaternion={stemQ} scale={radius}>
          <mesh position={[0, -0.85, 0]}>
            <sphereGeometry args={[0.55, 20, 14]} />
            <meshStandardMaterial
              color={selected ? '#60a5fa' : '#fb923c'}
              transparent
              opacity={0.4}
              depthWrite={false}
            />
          </mesh>
          <mesh position={[0, -0.42, 0]}>
            <cylinderGeometry args={[0.22, 0.22, 0.85, 14]} />
            <meshStandardMaterial
              color={selected ? '#60a5fa' : '#fb923c'}
              transparent
              opacity={0.35}
              depthWrite={false}
            />
          </mesh>
          {/* Axis arrow — aim this along the limb */}
          <mesh position={[0, 0.55, 0]} rotation={[0, 0, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 0.7, 8]} />
            <meshStandardMaterial color={selected ? '#e2e8f0' : '#94a3b8'} />
          </mesh>
          <mesh position={[0, 1.0, 0]}>
            <coneGeometry args={[0.14, 0.28, 8]} />
            <meshStandardMaterial color={selected ? '#f8fafc' : '#cbd5e1'} />
          </mesh>
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
  selectedId,
  baseRadius,
  onSelect,
  onChange,
}: JointMarkersProps) {
  return (
    <>
      {joints.map((joint) => (
        <JointMarker
          key={`${joint.id}-${joint.axis}-${Math.round(joint.rotation)}-${(joint.tilt ?? [0, 0, 0]).map((t) => Math.round(t)).join(',')}`}
          joint={joint}
          selected={joint.id === selectedId}
          baseRadius={baseRadius}
          onSelect={() => onSelect(joint.id)}
          onChange={(patch) => onChange(joint.id, patch)}
        />
      ))}
    </>
  )
}
