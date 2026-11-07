# PLA snap-fit test joint

Print both parts in **PLA or PLA+**. The app uses this one snap for both. PETG, ABS/ASA, and TPU are shown grayed out until a print test exists.

| File | What |
|------|------|
| `pla-ball-stem-v12.stl` / `pla-socket-v12.stl` | Validated pair used for **PLA and PLA+** |
| `pla-d4-angled-ball-stem-v12.stl` / `pla-d4-angled-socket-v12.stl` | **Small joint** — Ø4 mm ball, joint face cut at 22° like an elbow; print flat side down, as exported |

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

## Hinge test — snap disc (v3)

For an elbow or knee, where a ball stem would be too thin. **Two parts, no separate pin.** The same stud and eye are molded into the body parts when you pick Hinge on a model.

| File | What |
|------|------|
| `hinge-stud-v3.stl` | Ø8 mm disc with a split Ø3 mm peg molded on. The peg tip has a 0.2 mm lip. |
| `hinge-eye-v3.stl` | Ø8 mm disc with a Ø3.1 mm hole. |

**First-guess fit (hone these):**
- Peg Ø**3.0 mm**, hole Ø**3.1 mm** — snug spin
- Lip Ø**3.4 mm**; the split lets it squeeze through the hole and spring back
- The lip shoulder sits **0.05 mm** inside the eye face, so it clamps the two discs together. That face rub holds the pose.

**Print-tested ✅ (PLA, 2026-11-07). Locked by `scripts/prove-hinge-locked.mts`.**

**Print**
- Stud: stand it upright on its arm end, with a brim. The peg then prints sideways, so its layers run along it and it's stronger.
- Eye: lying flat on the disc face, as exported, so the hole prints round.
- 0.2 mm layers, 3–4 walls. No supports.

Push the peg straight through the hole until it clicks. It should turn by hand and stay where you leave it.

Tuning lives in `src/lib/hingeProfile.ts`:
- Peg won't go in, or the prongs crack → lower `lipMm` or raise `splitWidth`.
- Pops back out → raise `lipMm`.
- Bend flops → raise `shoulderPreload` (more clamp) or lower `holeClearance`.
- Too stiff to turn → lower `shoulderPreload` or raise `holeClearance`.

Regenerate: `npx tsx scripts/gen-hinge-test-joint.mts`

## Knuckle test — fork + tongue (v1)

The toy-robot joint: a rounded tongue on one limb sits between the two cheeks of a fork on the other. **Two parts, no separate pin.** Bends about ±90°. The same fork and tongue are molded into the body parts when you pick Knuckle on a model.

| File | What |
|------|------|
| `knuckle-fork-v1.stl` | Ø9 mm barrel, 9 mm wide fork, 2 mm cheeks. A Ø3.2 mm cone bump (0.6 mm tall) on each cheek's inside face. |
| `knuckle-tongue-v1.stl` | Ø9 mm × 4.7 mm tongue with a cone dimple in each face. |

**First-guess fit (hone these):**
- **0.15 mm** air between each tongue face and its cheek
- The dimples are **0.08 mm** shallower than the bumps, so the cheeks stay sprung apart and pinch the tongue. That pinch holds the pose.

**Print**
- Both parts lying on their side, as exported (bend axis vertical). The upper cheek's bump is a 45° cone, so it needs no support.
- 0.2 mm layers, 3–4 walls. No supports.

Slide the tongue into the fork from the open end until the bumps click into the dimples. It should bend by hand and stay where you leave it.

Tuning lives in `src/lib/knuckleProfile.ts`:
- Won't snap in, or a cheek cracks → lower `bumpHeight` or thin the `cheek`.
- Pops out → raise `bumpHeight`.
- Bend flops → raise `preload` (more pinch) or lower `sideGap`.
- Too stiff to bend → lower `preload`.

### Thin knuckle — Dag 4″ knee size (v1)

**Print-tested ✅ (PLA, 2026-11-07). Locked by `scripts/prove-knuckle-locked.mts`.**

The exact knuckle the app builds at the thinnest Auto-Suggest knee on `Dag_natural_happy_4inch.stl`. Same fit numbers (side gap, preload, bump height), smaller and narrower body — it checks the snap still works where the limb is thin.

| File | What |
|------|------|
| `knuckle-dag4-knee-fork-v1.stl` | Ø11.7 mm barrel, 6.8 mm wide fork, 1.6 mm cheeks, Ø4.1 mm × 0.6 mm bumps. |
| `knuckle-dag4-knee-tongue-v1.stl` | 3.2 mm tongue with a dimple in each face. |

The Dag 4″ elbows come out within 5% of the standard pair, so the standard pair stands in for them.

Regenerate: `npx tsx scripts/gen-knuckle-test-joint.mts --robot ~/Downloads/Dag_natural_happy_4inch.stl --name dag4`
(without `--robot`, only the standard pair)
