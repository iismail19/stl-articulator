import * as THREE from 'three'

/** Split a mesh into connected components by shared vertices. */
export function splitConnectedComponents(
  geometry: THREE.BufferGeometry,
): THREE.BufferGeometry[] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  let index = geometry.getIndex()

  // Build an index if missing
  if (!index) {
    const idx = new Uint32Array(pos.count)
    for (let i = 0; i < pos.count; i++) idx[i] = i
    geometry = geometry.clone()
    geometry.setIndex(new THREE.BufferAttribute(idx, 1))
    index = geometry.getIndex()!
  }

  const triCount = index.count / 3
  const parent = new Int32Array(triCount)
  for (let i = 0; i < triCount; i++) parent[i] = i

  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  const unite = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  const vertMap = new Map<string, number[]>()
  const keyFor = (vi: number) =>
    `${pos.getX(vi).toFixed(5)},${pos.getY(vi).toFixed(5)},${pos.getZ(vi).toFixed(5)}`

  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const key = keyFor(index.getX(t * 3 + k))
      let list = vertMap.get(key)
      if (!list) {
        list = []
        vertMap.set(key, list)
      }
      list.push(t)
    }
  }

  for (const list of vertMap.values()) {
    for (let i = 1; i < list.length; i++) unite(list[0], list[i])
  }

  const groups = new Map<number, number[]>()
  for (let t = 0; t < triCount; t++) {
    const root = find(t)
    let g = groups.get(root)
    if (!g) {
      g = []
      groups.set(root, g)
    }
    g.push(t)
  }

  const parts: THREE.BufferGeometry[] = []
  const normsAttr = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined

  for (const tris of groups.values()) {
    if (tris.length < 4) continue
    const verts: number[] = []
    const norms: number[] = []
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(t * 3 + k)
        verts.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi))
        if (normsAttr) {
          norms.push(normsAttr.getX(vi), normsAttr.getY(vi), normsAttr.getZ(vi))
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    if (norms.length) {
      g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3))
    } else {
      g.computeVertexNormals()
    }
    parts.push(g)
  }

  parts.sort((a, b) => {
    const ac = (a.getAttribute('position') as THREE.BufferAttribute).count
    const bc = (b.getAttribute('position') as THREE.BufferAttribute).count
    return bc - ac
  })

  return parts.length ? parts : [geometry.clone()]
}
