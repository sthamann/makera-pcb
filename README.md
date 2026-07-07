<div align="center">

# makera-pcb

**Turn KiCad Gerber + drill files into ready-to-mill G-code for the Makera Carvera Air — in one app.**

Isolation milling · drilling · outline cutting — with a feasibility check, 2D **and** 3D preview,
a per-tool library (one `M6` program), an AI config check, a fully guided fabrication workflow,
and **direct machine control** (discover → status → upload → run). No FlatCAM, no MakeraCAM needed.

![Node ≥18](https://img.shields.io/badge/Node-%E2%89%A518-3c873a)
![tests](https://img.shields.io/badge/tests-45%20passing-2ecc71)
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

- **Load defaults** fills the complete Carvera Air toolkit.
- **Makera PCB feeds** sets feed/plunge/RPM of every tool to the official Makera
  speeds & feeds table (PCB column): V-bit 12000/500/200, corn bit 12000/500/300,
  drill 10000/1000/200, solder-mask remover 6000/400/200.

Assign a tool to each step (isolation, drilling per Ø, outline — “Auto-assign” does it
by type/Ø). When all steps are assigned you also get **`0_full_job.nc`** — a single
program with `M6 T… S…` changes in the right order. On the Carvera Air each `M6` pauses
for the manual tool swap and then measures the tool length automatically.

<br clear="all" />

## 🧱 Material / stock

<img src="docs/img/material.png" align="right" width="300" />

In **Material & Files** pick the **stock (blank)** — the standard Makera PCB blanks
(FR4 1.5 mm, single/double-sided, **100×150** and **150×200 mm**) plus “generic FR4 1.6 mm”
and “custom”. The choice sets thickness (Z) and stock size (X/Y, with ⇄ swap). A **live
preview** shows the blank with the board on it and whether it **fits**. The feasibility
check also verifies the board fits the stock (incl. ~4 mm clamping margin).

<br clear="all" />

## 🛠 Guided fabrication (to-scale diagrams)

<img src="docs/img/fabrication.png" align="right" width="300" />

The **Fabrication** tab holds your hand through the real build, in the exact Makera order
(**wired probe first — margin/Z/leveling — then the cutting tool**):

1. **Fix the board flat** at anchor 1 (with a to-scale top view + side-view layer stack).
2. **Set XY origin** (Makera offset X15/Y10 from anchor 1).
3. **Insert the wired probe (T0).**
4. **Config & Run:** Scan Margin + Auto Z Probe + Auto Leveling (5×5, H2) in one go.
5. **Insert the isolation tool** (tool length auto-measured on every change).
6. Mill isolation → drill → cut outline → optional laser silkscreen → remove & finish.

Every step has a **to-scale illustration of the real Carvera Air** (300 × 200 mm work area,
grey L-bracket at anchor 1 with its **2 dowel pins + 3 M5 screws**, waste board, top clamps,
and the board **dimensioned in mm**). Each step shows an estimated time, the tool, a
**▶ Start** (uploads the right `.nc` and runs it) and a “done” check; UV solder-mask steps
include a curing timer.

> **Waste board:** MDF (or an acrylic/HDF offcut), **1–2 mm** thick, about **20 mm larger**
> than the PCB all around — so drills/outline go into the MDF instead of the machine bed.

<br clear="all" />

## 🤖 Machine control (Carvera Air)

<img src="docs/img/machine.png" align="right" width="300" />

1. **Search** — finds the machine via UDP broadcast (port 3333, marked **free/busy**).
2. **Connect** — TCP (port 2222). The protocol is auto-detected (framed firmware ≥ 1.0.5
   or legacy plain-text). Then: live status, MDI, **Upload** and **Upload & start (play)**.
3. **Connection profiles** — save IP/port as a named profile.

**Device control:** jog pad (X/Y/Z/A), home/unlock/reset, set origin, go to clearance/origin,
scan margin, Z-probe, auto-leveling; an **Accessories** panel for light, auto-vacuum, air
assist, spindle fan, beep, collet open/close, calibrate, height-map show/clear; pause/resume/stop;
live progress; and an **alarm banner** with plain-language hints + a troubleshooting panel.

> **Protocol note:** current firmware (≥ 1.0.5, e.g. Carvera Air **1.0.6**) speaks a **binary
> framing protocol** (`0x8668 … CRC16 … 0x55AA`) — a plain `?` is ignored (why status used to
> stay empty). This app auto-detects and frames commands, realtime bytes and file uploads.
> The Carvera serves **one** network client at a time — quit MakeraCAM/the controller (and
> unplug USB) first.

<br clear="all" />

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
| General | `safeZ` / `travelZ` | 5 / 1.5 | rapid clearance / travel height |
| Isolation | `isolation.tool` | `vbit` | `vbit` or `endmill` |
| | `isolation.vbitAngleDeg` | 30 | V-bit included angle |
| | `isolation.tipWidth` | 0.1 | tip width (mm) |
| | `isolation.cutDepth` | 0.15 | cut depth into copper (mm) |
| | `isolation.passes` | 2 | isolation passes |
| | `isolation.overlap` | 0.4 | pass overlap (0–0.9) |
| | `isolation.feedXY` / `rpm` | 300 / 12000 | feed / spindle speed |
| Drilling | `drill.throughMargin` | 0.3 | break-through margin (mm) |
| | `drill.peck` | 0.6 | peck depth per bite (mm) |
| | `drill.remap` | `[]` | remap bits, e.g. `[{ "from":1.3, "to":1.2 }]` |
| Outline | `outline.cutterDiameter` | 1.0 | cutter Ø (mm) |
| | `outline.depthPerPass` | 0.4 | depth per pass (mm) |
| | `outline.tabs` | 4 | number of holding tabs |
| | `outline.tabWidth` / `tabHeight` | 2 / 0.4 | tab width / remaining height (mm) |
| | `outline.offsetSide` | `outside` | `outside` / `on` / `inside` |

The effective V-bit width grows with depth (`tipWidth + 2·cutDepth·tan(angle/2)`) and feeds
into the feasibility check.

## 🏗 How it works

| Module | Job |
|---|---|
| `src/gerber/` | RS-274X parser (format, apertures, macros incl. `RoundRect`, flashes/draws/regions, polarity, arcs) |
| `src/excellon/` | drill data (tools, coordinates, slots) |
| `src/geometry/` | Clipper wrapper: union/difference/offset, circle approximation |
| `src/cam/` | isolation (concentric offsets), drilling (peck, nearest-neighbour), outline (stitch, offset, tabs), G-code |
| `src/cam/checks.js` | smallest copper gap (offset-to-merge) vs. tool |
| `src/machine.js` | Carvera network: UDP discovery, framing protocol (auto-detected) + plain-text fallback, live status, MDI/realtime, file upload |
| `src/ai.js` | OpenAI config review (testable prompt/parser, API call in the server) |
| `web/public/app.js` | UI: 2D/demo animation, tools, AI check, machine, projects |
| `web/public/i18n.js` | DE/EN dictionary + `t()`/`applyI18n()` (language switch) |
| `src/pipeline.js` | ties it together → files, report, 2D/3D preview |

> The 3D view uses a prebuilt bundle (`web/public/view3d.bundle.js`). After changing
> `web/public/view3d.js`, rebuild with `npm run build:viewer`.

## 🚧 Limits

- Only the **F.Cu layer** is isolated (single-sided; no mirroring for double-sided yet).
- Isolation only (no copper-area clearing — the stock Makera `.nc` also clears the background).
- Routed slots in the drill file are reported but not milled automatically.

## ✅ Tests

```bash
npm test
```

Covers geometry, apertures/macros, Gerber & Excellon parsers, outline stitching, the combined
`M6` program, the Carvera status parser, CRC-16/XMODEM, the framing encoder and a file upload
over the framing protocol against a protocol-faithful mock, the AI prompt/parse helpers, and an
end-to-end run on the real I²C board.
