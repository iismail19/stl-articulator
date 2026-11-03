# PLA snap-fit test joint

Print both parts in **PLA**. The app’s **PLA** filament profile uses these exact snap values on every model cut.

| File | What |
|------|------|
| `pla-ball-stem-v10.stl` | Base + thick short stem + ball (male) |
| `pla-socket-v10.stl` | Block with snap socket (female) |
| `pla-ball-stem.stl` / `pla-socket.stl` | Same as latest version (aliases) |

**Validated snap (from real print):**
- Socket clearance **1.05×** ball radius (pose hold)
- Mouth **0.955×** (inserts without cracking)
- 4 flex slots through the lip

**Sizes:** ball Ø ~8 mm — small, fast test print.

**Print tips**
- Socket: opening facing **up**
- Ball: base on the bed, ball pointing up
- 0.2 mm layers, 3–4 walls, ~20% gyroid
- Let cool fully, then push the ball straight into the socket

App downloads:
- http://127.0.0.1:5173/test-joints/pla-ball-stem-v10.stl
- http://127.0.0.1:5173/test-joints/pla-socket-v10.stl
