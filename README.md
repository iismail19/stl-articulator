# STL Articulator

Free browser tool to turn a solid STL into a poseable figure with ball-and-socket joints — similar to PrintPal’s Flexi / Articulated Model Creator.

## Features

- Upload any STL and inspect it in a 3D viewer
- Click to place joints (neck, shoulders, elbows, hips, …)
- Tune **cut axis**, **position**, **scale**, and **rotation** per joint
- Drag the gizmo to reposition
- **Download Cut Model** — boolean-subtracts Saturn-style cutters (print-in-place flexi)
- **Download Separate Parts** — splits connected bodies after cutting so you can print pieces and snap ball into socket
- **Download Cutters Only** — export cutter meshes for use in Blender / Meshmixer

## Run locally

```bash
cd stl-articulator
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Suggested workflow

1. Upload a **watertight** single-body STL
2. Click **+ Add**, then click a limb/neck where you want movement
3. Adjust axis so the orange ring cuts fully through the part
4. Scale until the ball sits inside the cross-section
5. Export cut model or separate parts
6. Slice at ~0.2 mm; leave a small joint gap if your slicer supports it

Large meshes (&gt;500k triangles) will make boolean cuts slow — remesh/decimate first if needed.

## Stack

- Vite + React + TypeScript
- Three.js / React Three Fiber
- `three-bvh-csg` for client-side boolean subtraction
