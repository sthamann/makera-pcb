<div align="center">

# makera-pcb

**Turn KiCad Gerber + drill files into ready-to-mill G-code for the Makera Carvera Air — in one app.**

Isolation milling · drilling · outline cutting — with a feasibility check, 2D **and** 3D preview,
a per-tool library (one `M6` program), an AI config check, a fully guided fabrication workflow,
and **direct machine control** (discover → status → upload → run). No FlatCAM, no MakeraCAM needed.

![Node ≥18](https://img.shields.io/badge/Node-%E2%89%A518-3c873a)
![tests](https://img.shields.io/badge/tests-133%20passing-2ecc71)
![no external CAM](https://img.shields.io/badge/no-FlatCAM%20needed-4c8dff)
![Makera Carvera Air](https://img.shields.io/badge/Makera-Carvera%20Air-ff5a5a)
![i18n](https://img.shields.io/badge/UI-DE%20%2F%20EN-8a94a6)

**English** · [Deutsch](README.de.md)

<img src="docs/img/preview.png" alt="2D board preview with layer filters" width="820" />

</div>

---

## ✨ Highlights

- **2D + 3D board view** — copper, silkscreen, drills and toolpaths; rotatable 3D (three.js).
- **Guided, to-scale workflow** — step-by-step fabrication with **accurate Carvera Air diagrams**
  (300 × 200 mm bed, anchor 1, L-bracket screw pattern, waste board, clamps, dimensions).
- **Tool library ↔ steps** — feed/plunge/RPM **per tool**; assign a tool to each step →
  a single **`0_full_job.nc`** with `M6` tool changes (instead of many files).
- **Official Makera feeds** — one click sets every tool to the Makera PCB speeds & feeds table.
- **Direct machine control** — UDP discovery, live status, jog, probing, auto-leveling, MDI,
  upload & `play` — speaking the machine's **binary framing protocol** (firmware ≥ 1.0.5, e.g. 1.0.6).
- **AI check (OpenAI)** — knows the exact Carvera Air specs/tools/blanks and returns
  concrete, one-click corrections.
- **UV solder-mask workflow** — apply → cure (with timer) → expose pads, plus laser silkscreen.
- **Bilingual UI (DE/EN)** and **projects** — save/load/export the whole workspace.

## 📸 Screenshots

| Material & files | Milling settings | Tools & single-file job |
|:---:|:---:|:---:|
| <img src="docs/img/material.png" width="260" /> | <img src="docs/img/config.png" width="260" /> | <img src="docs/img/tools.png" width="260" /> |
| **Guided fabrication (to-scale)** | **Machine control** | **2D / 3D preview** |
| <img src="docs/img/fabrication.png" width="260" /> | <img src="docs/img/machine.png" width="260" /> | <img src="docs/img/preview.png" width="260" /> |

## 🚀 Quick start

```bash
cd makera-pcb
npm install
npm start
```

Open `http://localhost:4321`, click **“Load example board”** (loads the I²C board from
`../platine/gerbers`) or drop your own Gerbers (F.Cu, Edge.Cuts, `.drl` are auto-detected).

The UI is organised into **workflow tabs**, in the order you actually work:
**1 Material & Files · 2 Milling Settings · 3 Tools · 4 Preview · 5 AI Check ·
6 Machine · 7 Fabrication · 8 Result**. “Generate G-code” is always reachable at the top.

```
Gerber (F.Cu) ─┐
Edge.Cuts     ─┼─►  makera-pcb  ─►  1_isolation.nc · 2_drill_<Ø>.nc · 4_outline.nc
Drill (.drl)  ─┘                    0_full_job.nc (M6) · FAB-PLAN.md
```

## 🧰 Tools & the single-file job

<img src="docs/img/tools.png" align="right" width="300" />

In **“3 · Tools (Carvera Air)”** define your tools (number, type, Ø, collet S1–S6,
**feed/plunge/RPM**, label — stored in the browser).

- **Load PCB pack** fills the **Makera PCB Fabrication Pack** tool list
  (V-bit 0.2 mm, engraving 0.3/0.5 mm, 2 mm corn bit, 2 mm spiral-O, 2 mm drill, laser)
  including default step assignments and 2 mm clearing/outline diameters.
- **Makera PCB feeds** sets feed/plunge/RPM of every tool to the official Makera
  speeds & feeds table (PCB column): V-bit 12000/500/200, corn bit 12000/500/300,
  drill 10000/1000/200, solder-mask remover 6000/400/200.

Assign a tool to each step — the list mirrors the fabrication order and covers
**every enabled step**: isolation, copper clearing, solder-mask removal, drilling
per Ø, outline and laser silkscreen (“Auto-assign” does it by type/Ø, and the list
updates live when you toggle options). When all spindle steps are assigned you also
get **`0_full_job.nc`** — a single program with `M6 T… S…` changes in the right order
(isolation → clearing → drills → outline). On the Carvera Air each `M6` drives to the
change position, beeps and **waits** — makera-pcb detects that wait state live and pops
a full-screen **tool-change dialog** (desktop *and* mobile remote) naming the tool, with
one confirm button that resumes the machine; it then measures the tool length
automatically. Steps that
run **outside** the spindle job carry a badge: the laser program is separate
(`M321` drops the tool) and mask removal is a guided manual step without G-code.

<br clear="all" />

## 🧱 Material / stock

<img src="docs/img/material.png" align="right" width="300" />

In **Material & Files** pick the **stock (blank)** — the standard Makera PCB blanks
(FR4 1.5 mm, single/double-sided, **100×150** and **150×200 mm**) plus “generic FR4 1.6 mm”
and “custom”. The choice sets thickness (Z) and stock size (X/Y, with ⇄ swap). A **live
preview** shows the blank resting against the L-bracket arms with the board where it
really ends up and whether it **fits**. Preview, feasibility check and report share
**one** fit rule (`web/public/stock-fit.js`) built on the verified anchor geometry:
the work origin sits **exactly at anchor 1 = the blank’s corner** (confirmed on a
real machine — no X15/Y10 offset), so the board starts **at the blank’s corner** —
board + ~4 mm clamping margin right/top must fit the blank, rotation counts.
If the board does not fit, the Material tab shows a **red warning** with the
required size and the smallest Makera blank that would fit.

**Board placement by drag & drop:** grab the board in the preview (mouse or touch)
and drag it across the blank — e.g. away from the very corner for extra safety
margin. It snaps to a **0.5 mm grid**, is clamped to the blank (incl. clamping
margin, red warning when it would not fit), and the numeric **Offset X/Y** fields
stay in sync (plus a reset button). The **work origin stays at anchor 1 (= the
blank corner)**; instead, every generated program (isolation, clearing, drilling,
outline, laser) is shifted by the offset, and scan margin / Z-probe / auto-leveling
run on the displaced board area. The offset is saved with the project.

<br clear="all" />

## 🛠 Guided fabrication (to-scale diagrams)

<img src="docs/img/fabrication.png" align="right" width="300" />

The **Fabrication** tab holds your hand through the real build, in the exact Makera order
(**wired probe first — margin/Z/leveling — then the cutting tool**):

1. **Fix the board flat** at anchor 1 (with a to-scale top view + side-view layer stack).
2. **Set XY origin** (exactly at anchor 1 = the board corner).
3. **Insert & measure the wired probe (T0)** — a real `M6 T0` (tool-change overlay),
   then the firmware measures the probe on the length sensor. That measurement is
   the reference all later tool lengths are computed against.
4. **Config & Run:** Scan Margin + Auto Z Probe **on the board at the work origin**
   (`M495 … O0 F0` — both letters; `O` without `F` would select the firmware's
   4th-axis absolute probe, which puts Z0 ~23 mm below the surface) + Auto
   Leveling (5×5…9×9, H2) in one go. Afterwards the **height map** is parsed from
   the machine log, shown as a colour-coded **3D surface** (green = flat, red =
   deviation) and checked for plausibility (total deviation / tilt / outliers).
5. **Insert the isolation tool** (tool length auto-measured on every change).
6. Mill isolation → optional copper clearing → (optional UV solder mask: clean →
   apply → cure → expose pads) → drill → cut outline → optional laser silkscreen →
   remove & finish.

Every step has a **to-scale illustration of the real Carvera Air** (300 × 200 mm work area,
grey L-bracket at anchor 1 with its **2 dowel pins + 3 M5 screws**, waste board, top clamps,
and the board **dimensioned in mm**). Each step shows an estimated time, the tool, a
**▶ Start** (uploads the right `.nc` and runs it) and a “done” check; UV solder-mask steps
include a curing timer. Machine steps are **monitored live** (`web/public/job-monitor.js`):
starting disables the buttons and shows “running…”, an M6 wait pops the tool-change dialog,
a finished run marks the step done and unlocks the next one, and an alarm marks it
**failed** with a plain-language hint instead of advancing. Steps are gated in order —
running a later step first asks for an explicit confirmation.

> **Waste board:** MDF (or an acrylic/HDF offcut), **1–2 mm** thick, about **20 mm larger**
> than the PCB all around — so drills/outline go into the MDF instead of the machine bed.

<br clear="all" />

## 🤖 Machine control (Carvera Air)

<img src="docs/img/machine.png" align="right" width="300" />

1. **Search** — finds the machine via UDP broadcast (port 3333, marked **free/busy**).
2. **Connect** — TCP (port 2222). The protocol is auto-detected (framed firmware ≥ 1.0.5
   or legacy plain-text). Then: live status, MDI, **Upload** and **Upload & start (play)**.
3. **Connection profiles** — save IP/port as a named profile.

**SD file browser** (collapsible in the Machine tab): browse the machine's SD card (`ls`),
view text files inline and download them (`cat`, reliable over TCP, no QuickLZ — for
G-code/Gerber/drill/`config.txt`), upload your own files into the current folder (framed file
transfer), create folders, rename and delete. This lets you inspect the bundled Makera
examples under `Examples/…` (e.g. `Examples/LED/PCB-UV-MASK(PART2).nc`).

A **setup assistant** at the top of the Machine tab walks you through every new
project with live state detection: 1 connect → 2 homing/alarm (with an
“acknowledge alarm” button) → 3 place the board at anchor 1 → 4 set the origin →
5 probe Z & auto-leveling → 6 start the job. Each step shows a status icon, one
button and one sentence.

**Device control** (grouped into *Set up*, *Move* and *Alarm & reset*): jog pad
(X/Y/Z/A), home/unlock/reset; **“Origin = anchor 1”** — one click that is
fault-tolerant by design: it checks the machine state first (alarm/homing/busy are
refused with a clear message), sends `M496.3` (the firmware itself raises Z and
rapids to the anchor), **waits until the machine is idle again** — `M496.x` moves
execute deferred on the firmware main loop, so a command sent right after would
race the move — and only then sets the origin with `G10 L20 P0 X-15 Y-10`
(pure coordinate bookkeeping, no extra motion, no soft-endstop risk);
**set origin XYZ/XY** at the jogged position, **“→ Park position (top right)”**
(`M496.1`), **“→ Work origin”** and **“Go to (work X/Y)”** (both move in *your*
work coordinate system, raising Z safely first); scan margin, Z-probe,
auto-leveling; an **Accessories** panel for light, the external vacuum, air
assist, spindle fan, beep, collet open/close, calibrate, height-map show/clear;
pause/resume/stop; live progress; and an **alarm banner** with plain-language
hints + a troubleshooting panel.

> **Vacuum / air-cleaner automation:** an external vacuum or air cleaner on the
> Carvera Air’s **external control port** is switched with `M851`/`M852`
> (firmware `switch.extendout`, verified in `config2.default` — `M331`/`M332`
> would only arm the Air’s *unconnected* internal-vacuum switch). With the
> automation enabled (default **on**, Accessories panel) every generated program
> switches the port on after the spindle start and off after the program end
> with a configurable **run-on** (default 10 s, `G4` dwell) — this lives in the
> G-code itself, so it works even without the app. On top, the app’s job monitor
> switches off after **aborts/failures** (whose files never reach their own
> `M852`) and can optionally pause the vacuum during `M6` tool changes and cover
> the separate laser program. The manual On/Off toggle stays (desktop + mobile)
> and shows the last commanded state.

> **Coordinates:** the machine’s built-in zero (MPos 0/0) is the homing reference corner
> at the **top right** — your workpiece origin at the board only exists after *set origin*.
> The status panel shows **WPos (workpiece)**, **MPos (machine)**, a **“work origin:
> set / not set”** badge and an **auto-leveling** row (the firmware’s `O:` status field =
> max height-map deviation while compensation is active); work-coordinate moves and job
> starts warn when no origin has been set yet (they would otherwise be measured from the
> top-right corner).

> **Safety gate before every job start:** the app refuses to start silently when
> (a) no Z origin is detectable (WCO-Z = 0 — Z never probed since homing), or
> (b) the height map / active compensation deviates more than **0.4 mm**
> (`LEVELING_MAX_DEV_WARN_MM`), is tilted > 0.3 mm or contains outlier cells —
> each with a plain-language explanation of what to check physically.

> **Protocol note:** current firmware (≥ 1.0.5, e.g. Carvera Air **1.0.6**) speaks a **binary
> framing protocol** (`0x8668 … CRC16 … 0x55AA`) — a plain `?` is ignored (why status used to
> stay empty). This app auto-detects and frames commands, realtime bytes and file uploads.
> The Carvera serves **one** network client at a time — quit MakeraCAM/the controller (and
> unplug USB) first.

<br clear="all" />

## 📱 Mobile remote control

Open `http://<computer-ip>:4321/mobile` on your phone (same Wi-Fi) — the URL and a QR code
are printed at server start. A touch-optimised remote for standing next to the machine:
connect/discover, live status (WPos prominent, MPos secondary), jog pad with step selection
(0.1/1/10 mm), home/unlock, go to work origin, set origin (with confirmation), pause/resume/stop
(stop with confirmation), job progress, alarm banner and accessory toggles. The server keeps the
single machine connection, so desktop and phone share it. DE/EN, no CAM features — remote only.

## 🧠 AI check (OpenAI)

Enter your OpenAI key (stays local in the browser, or use `.env`), pick a model
(default `gpt-5.5`) and **Check configuration**. The AI rates feasibility/feeds/speeds/depths
for *this* board and returns concrete **corrections as a patch** you apply with one click.

Create `makera-pcb/.env` (template: `.env.example`):

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
```

`.env` is git-ignored and auto-loaded on start. With a server key present the check shows
“active (.env)” and **Auto-check** runs after every generation.

## 💾 Projects & 🌐 language

- **Projects:** save/load the **entire workspace** (Gerber files, all settings, tools,
  assignments, material, layers), export/import as `*.mkpcb.json`. The last project is
  restored automatically on start.
- **Language:** DE/EN switch (top-right) toggles the whole UI live — tabs, forms, the guided
  steps, the diagrams, troubleshooting and messages. The choice is remembered.

## ⌨️ Command line

```bash
# process a whole Gerber folder
node src/cli.js ../platine/gerbers --out out

# individual files
node src/cli.js --copper F_Cu.gbr --edge Edge_Cuts.gbr --drill board.drl --out out

# override parameters
node src/cli.js ../platine/gerbers --set isolation.cutDepth=0.12 --set outline.tabs=6
```

Output lands in `out/` (`*.nc` + the fabrication plan).

## ⚙️ Configuration

| Area | Key | Default | Meaning |
|---|---|---|---|
| Material | `material.thickness` | 1.5 | material thickness (mm) |
| General | `safeZ` / `travelZ` | 12 / 2 | cross-board rapid clearance (above clamps) / short hop between nearby features on the board |
| Isolation | `isolation.tool` | `vbit` | `vbit` or `endmill` |
| | `isolation.vbitAngleDeg` | 30 | V-bit included angle |
| | `isolation.tipWidth` | 0.2 | tip width (mm, PCB pack V-bit 30° 0.2 mm) |
| | `isolation.cutDepth` | 0.15 | cut depth into copper (mm) |
| | `isolation.passes` | 2 | isolation passes |
| | `isolation.overlap` | 0.4 | pass overlap (0–0.9) |
| | `isolation.feedXY` / `rpm` | 300 / 12000 | feed / spindle speed |
| Drilling | `drill.throughMargin` | 0.3 | break-through margin (mm) |
| | `drill.peck` | 0.6 | peck depth per bite (mm) |
| | `drill.remap` | `[]` | remap bits, e.g. `[{ "from":1.3, "to":1.2 }]` |
| Outline | `outline.cutterDiameter` | 2.0 | cutter Ø (mm, PCB pack spiral-O 2 mm) |
| | `outline.depthPerPass` | 0.4 | depth per pass (mm) |
| | `outline.throughMargin` | 0.2 | break-through below material bottom on final pass (mm) |
| | `outline.tabs` | 4 | number of holding tabs |
| | `outline.tabWidth` / `tabHeight` | 2 / 0.4 | tab width / remaining material height under each tab (mm) |
| | `outline.offsetSide` | `outside` | `outside` / `on` / `inside` |
| Placement | `placement.offsetX` / `offsetY` | 0 / 0 | board offset from the blank corner (drag & drop, mm) |
| Vacuum | `vacuum.enable` | `true` | external-port automation (M851/M852) in every program |
| | `vacuum.lingerSec` | 10 | run-on after the program end (s, `G4` dwell) |
| | `vacuum.pauseToolChange` | `false` | switch off while an `M6` waits for the tool |
| | `vacuum.laser` | `true` | also run during the separate laser program |
| Clearing | `clearing.enable` | `false` | mill away the background copper (opt-in) |
| | `clearing.toolDiameter` | 2.0 | flat endmill / corn bit Ø (mm, PCB pack) |
| | `clearing.stepoverFrac` | 0.4 | pass overlap fraction (0–0.95) |
| | `clearing.cutDepth` | 0.12 | cut depth into copper (mm) |
| | `clearing.margin` | 0.4 | keep-out from the board edge (mm) |
| | `clearing.gap` | 0.1 | extra clearance kept around traces (mm) |
| | `clearing.feedXY` / `plungeFeed` / `rpm` | 500 / 300 / 12000 | feed / plunge / spindle speed |

The effective V-bit width grows with depth (`tipWidth + 2·cutDepth·tan(angle/2)`) and feeds
into the feasibility check.

## 🏗 How it works

| Module | Job |
|---|---|
| `src/gerber/` | RS-274X parser (format, apertures, macros incl. `RoundRect`, flashes/draws/regions, polarity, arcs) |
| `src/excellon/` | drill data (tools, coordinates, slots) |
| `src/geometry/` | Clipper wrapper: union/difference/offset, circle approximation |
| `src/cam/` | isolation (concentric offsets), clearing (concentric-offset pocket, background copper removal), drilling (peck, nearest-neighbour), outline (stitch, offset, tabs), G-code |
| `src/cam/checks.js` | smallest copper gap (offset-to-merge) vs. tool |
| `src/machine.js` | Carvera network: UDP discovery, framing protocol (auto-detected) + plain-text fallback, live status, MDI/realtime, file upload |
| `src/ai.js` | OpenAI config review (testable prompt/parser, API call in the server) |
| `web/public/app.js` | UI: 2D/demo animation, tools, AI check, machine (incl. setup assistant), projects |
| `web/public/machine-commands.js` | pure machine-control command builders + WCO/origin helpers (unit-tested) |
| `web/public/stock-fit.js` | shared board-fits-stock rule (anchor offset + clamp margin) used by UI preview **and** feasibility check |
| `web/public/i18n.js` | DE/EN dictionary + `t()`/`applyI18n()` (language switch) |
| `src/pipeline.js` | ties it together → files, report, 2D/3D preview |

> The 3D view uses a prebuilt bundle (`web/public/view3d.bundle.js`). After changing
> `web/public/view3d.js`, rebuild with `npm run build:viewer`.

## 🚧 Limits

- Only the **F.Cu layer** is isolated (single-sided; no mirroring for double-sided yet).
- Optional **copper-area clearing** (background pour removal) mills away the remaining
  background copper with a flat endmill/corn bit — off by default (`clearing.enable`).
- Routed slots in the drill file are reported but not milled automatically.

## ✅ Tests

```bash
npm test
```

Covers geometry, apertures/macros, Gerber & Excellon parsers, outline stitching, the combined
`M6` program (incl. clearing in / laser & mask steps out), the Carvera status parser,
CRC-16/XMODEM, the framing encoder and a file upload over the framing protocol against a
protocol-faithful mock, the machine-control coordinate logic (work-coordinate goto, the
two-phase anchor-1 origin sequence incl. precondition checks, WCO/origin detection), the
shared stock-fit rule (example board 138.5×30: fits the standard 150×100 Makera blank —
the anchor offset only skips the bracket arms — while 100×50 correctly fails),
the job-monitor state machine (running / tool-change wait / done / failed, incl. the
M6 manual-tool-change semantics of the Air),
the status parser against byte-faithful firmware-1.0.6 report strings (5-axis
MPos/WPos, manual-tool-change T field, leveling `O:` field, halt reason),
the M495 automation builders (regression: the workpiece Z probe always carries
`O` **and** `F` — `O` alone selects the firmware's 4th-axis probe and puts Z0
~23 mm below the surface; plus the placement offset in X/Y/C/D), the height-map
parser + plausibility assessment (against the real 9×5 leveling log), the
project-scoped reset logic, the external-vacuum automation (M851/M852 in every
generated program: on after spindle start, off after the end with run-on dwell,
optional tool-change pause, laser switch, plus the app-side transition plan),
the board placement offset (shifts every operation in the G-code while preview
and geometry stay board-local, feeds the fit check, snap + clamp rules),
operation completeness per config, the AI prompt/parse helpers, and an end-to-end run on
the real I²C board.
