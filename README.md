# STL Articulator

Free browser tool that turns a solid STL figure into a poseable one: it cuts the model at each joint you mark and molds snap-fit joint hardware into the two parts, with no separate pins and no glue. Similar to PrintPal's Flexi / Articulated Model Creator.

## Features

- Upload an STL and inspect it in 3D
- **Auto-Suggest** places the 7 figure joints (neck, 2 shoulders, 2 elbows, 2 knees) with a sensible joint type for each; it never moves markers you placed
- Click **+ Add** to place your own joints; each ring auto-sizes to its limb
- Per joint: joint type, cut axis, tilt, twist, and **Flip 180°** (trade which part gets the socket / hole / fork). The see-through ball on each marker shows the side it goes on
- **Preview Split Joints**, then download the parts
- In-browser **Simplify Mesh** for very dense models
- **Test prints** page (sidebar → 🧪 Test prints): every test pair with a 3D preview and a download button

## Joint types — which to use where

| Joint | How it moves | Best for | Needs | Status |
|---|---|---|---|---|
| **Ball & socket** | Swings any direction and twists | Neck, shoulders, hips: thick spots that need the most freedom | Room for a ball of at least Ø4 mm plus its socket wall | Print-tested ✅ (PLA / PLA+) |
| **Knuckle** | Bends one way (about ±90°), like a toy robot. A rounded tongue sits in a fork; molded bumps snap into dimples and pinch to hold the pose | Elbows, knees, ankles on robots and thin limbs: the best choice for small (3–4″) figures | A tongue at least 2 mm thick (warns below that) | Print-tested ✅ (PLA): standard 9 mm and thin 6.8 mm knee size |
| **Hinge** | Bends one way. A peg molded on one disc snaps through a hole in the other | Elbows and knees on chunkier limbs, or where a flat, disc-style joint looks right | A peg at least Ø2.4 mm (warns below that) | Print-tested ✅ (PLA). Print the peg part upright so the peg's layers run along it |
| **Swivel** | Twists all the way round the limb. A split post molded on one part clicks into a hole in the other (the hinge's snap, pointed along the limb) | Forearm or waist twist | A post at least Ø2.4 mm (warns below that) | Needs a test print 🟡 |
| **Universal** | Bends two ways on a thin limb | Wrists, ankles | — | Not built yet (cut only) |

**Rules of thumb**

- **Needs to look around or swing out?** Ball & socket.
- **Bends like a door, front-to-back?** Knuckle on thin or small parts, hinge on thick ones. On a 4″ figure the knuckle gets a ~3 mm tongue where a hinge only fits a 2 mm peg.
- **Model is small and you don't want to scale it up?** Ball for the neck and shoulders, knuckle for everything else.
- One-axis joints (knuckle, hinge) bend front-to-back automatically. Use **Twist** to aim the yellow pivot bar if a limb needs to bend another way.

## Test-print first

The snap fits are tuned for **PLA / PLA+** only; PETG, ABS/ASA and TPU stay disabled until they're tested. Before using a joint type on a model, print its test pair from the Test prints page (files live in `public/test-joints/`, details in `public/test-joints/README.md`). Each pair takes about 15–30 minutes at 0.2 mm layers with 3–4 walls.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints. If another app already holds port 5173, use the `127.0.0.1` address or the alternative port Vite shows.

## Workflow

1. Upload a **watertight**, single-body STL (simplify first if it's over ~500k triangles)
2. Click **✨ Auto-Suggest**, or **+ Add** and click each joint spot
3. Check each marker's joint type and axis; the yellow pivot bar shows the bend line on one-axis joints
4. **▶ Preview Split Joints** and look over the parts with Explode
5. Download the parts and print

## Checks

Proof scripts run the real cut engine in Node and fail loudly on regressions:

```bash
npx tsx scripts/prove-tolerance.mts      # ball fit matches the print-tested pair
npx tsx scripts/prove-ball-locked.mts    # ball output identical to the locked engine
npx tsx scripts/prove-knuckle-locked.mts # knuckle (standard + thin) identical to the print-tested pairs
npx tsx scripts/prove-hinge-locked.mts   # hinge identical to the print-tested pair
npx tsx scripts/prove-kind-isolation.mts # editing one joint type never changes another
npx tsx scripts/prove-simplify.mts       # Simplify Mesh keeps the model watertight and cuttable
npx tsx scripts/prove-knuckle-cut.mts
npx tsx scripts/prove-hinge-cut.mts
npx tsx scripts/prove-swivel-cut.mts
npx tsx scripts/prove-flip.mts
npx tsx scripts/prove-marker-side.mts    # marker shows the side the cut really uses
npx tsx scripts/prove-figure-suggest.mts
```

Some read local test models from `fixtures/` or `~/Downloads/` and skip when those aren't there.

## Stack

- Vite + React + TypeScript
- Three.js / React Three Fiber
- `manifold-3d` (WASM) for the boolean cuts and joint hardware, with `three-bvh-csg` as a fallback
