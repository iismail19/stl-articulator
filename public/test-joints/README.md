# PLA snap-fit test joint

Print both parts in **PLA or PLA+**. The app uses this one snap for both. PETG, ABS/ASA, and TPU are shown grayed out until a print test exists.

| File | What |
|------|------|
| `pla-ball-stem-v12.stl` / `pla-socket-v12.stl` | Validated pair used for **PLA and PLA+** |
| `pla-firm-*-v12.stl` | Retired tighter-cup experiment (not in the app) |
| `pla-tight-*-v12.stl` | Retired zero-gap experiment (not in the app) |
| `*-d4-angled-*-v12.stl` | **Small joint** — Ø4 mm ball, joint face cut at 22° like an elbow; print flat side down, as exported |
| `*-v10.stl` | Original large-block PLA pair that validated the fit (has a bore under the cup — ball can be pushed too deep) |
| `pla-ball-stem.stl` / `pla-socket.stl` | Same as latest version (aliases) |

**Validated snap (from real print), shared by PLA and PLA+:**
- Socket clearance **1.05×** ball radius
- Mouth **0.955×** (inserts without cracking)
- 4 flex slots through the lip

**Sizes (v12):** ball Ø8 mm on a 15 × 15 × 2.5 mm base; socket block ~12.5 × 12.5 × 10 mm.

**Print tips**
- Socket: opening facing **up**
- Ball: base on the bed, ball pointing up
- 0.2 mm layers, 3–4 walls, ~20% gyroid
- Let cool fully, then push the ball straight into the socket

Regenerate: `npx tsx scripts/gen-pla-test-joint.mts pla`
