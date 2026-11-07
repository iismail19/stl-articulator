import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

const SIZE = 256
let renderer: THREE.WebGLRenderer | null = null
const cache = new Map<string, Promise<string>>()

/** One offscreen renderer for every thumbnail — browsers cap live WebGL contexts. */
function getRenderer(): THREE.WebGLRenderer {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.setSize(SIZE, SIZE, false)
  }
  return renderer
}

async function render(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const geo = new STLLoader().parse(await res.arrayBuffer())
  geo.computeVertexNormals()
  geo.center()
  geo.computeBoundingSphere()
  const r = geo.boundingSphere?.radius || 1

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xe2e8f0, 0x1e293b, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(1, 1.4, 1.2)
  scene.add(key)
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xfb923c, roughness: 0.55, metalness: 0.05 }),
  )
  scene.add(mesh)

  // Printed parts are exported Z-up on the bed; view them from a raised 3/4 angle.
  const camera = new THREE.PerspectiveCamera(30, 1, r / 100, r * 100)
  camera.up.set(0, 0, 1)
  const dist = r / Math.sin(THREE.MathUtils.degToRad(15)) * 1.05
  camera.position.set(1, -1.3, 0.9).normalize().multiplyScalar(dist)
  camera.lookAt(0, 0, 0)

  const gl = getRenderer()
  gl.render(scene, camera)
  const png = gl.domElement.toDataURL('image/png')
  geo.dispose()
  ;(mesh.material as THREE.Material).dispose()
  return png
}

/** PNG data URL of an STL, rendered once per URL. */
export function stlThumbnail(url: string): Promise<string> {
  let p = cache.get(url)
  if (!p) {
    p = render(url)
    cache.set(url, p)
  }
  return p
}
