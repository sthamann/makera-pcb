// Default job configuration tuned for the Makera Carvera Air milling FR4.
// Every value is overridable from the CLI/Web UI. Feeds/speeds are deliberately
// conservative starting points; verify on your machine and material.

// Anchor offset + clamp margin live in the SHARED stock-fit module so the
// browser preview and the server-side feasibility check use the same numbers.
export { CARVERA_ANCHOR_OFFSET, STOCK_CLAMP_MARGIN_MM, PLACEMENT_SNAP_MM } from '../web/public/stock-fit.js';
// External vacuum / air cleaner codes + default run-on are shared with the
// browser machine control (single source of truth, firmware-verified there).
import { VACUUM_LINGER_DEFAULT_S } from '../web/public/machine-commands.js';
export { VACUUM_ON_COMMAND, VACUUM_OFF_COMMAND, VACUUM_LINGER_DEFAULT_S } from '../web/public/machine-commands.js';
// Makera solder-mask removal bit (No.5, spring-loaded) — used for the
// mask-removal tool-assignment row (guided manual step, no G-code).
// PCB Fabrication Pack: Single Flute Engraving Bit 30° × 0.3 mm (tip size).
export const SOLDER_MASK_REMOVER_DIAMETER = 0.3;
export const SOLDER_MASK_REMOVER_RPM = 6000;
// Nominal 5 W laser spot size for the silkscreen-engraving assignment row.
export const LASER_SPOT_DIAMETER = 0.1;
// Clearance high enough to pass over Carvera top clamps on cross-board rapids.
export const CARVERA_SAFE_Z_DEFAULT = 12.0;
// Short Z hop between nearby features on the same board (must stay below safeZ).
export const CARVERA_TRAVEL_Z_DEFAULT = 2.0;
// Fallback tool numbers when no tool-library assignment is present (Makera kit).
// Fallback T# when no tool-library assignment (Makera PCB Fabrication Pack).
export const DEFAULT_TOOL_NUMBER = {
  isolation: 1,
  clearing: 4,
  outline: 5,
  drillBase: 6,
  maskRemove: 2,
  laser: 7,
};

export const defaultConfig = {
  material: {
    thickness: 1.5, // mm (Makera blanks are 1.5 mm copper-clad FR4)
  },
  // Stock/blank the board is cut from. Used to check the board fits and to guide
  // the workflow. sides = 'single' | 'double'.
  stock: {
    material: 'mk-ss-100x150',
    sizeX: 150,
    sizeY: 100,
    sides: 'single',
  },
  origin: 'edge-cuts', // work origin at the outline bottom-left corner
  safeZ: CARVERA_SAFE_Z_DEFAULT, // rapid clearance above stock / clamps
  travelZ: CARVERA_TRAVEL_Z_DEFAULT, // low hop between nearby features on the board

  // Board placement on the blank (drag & drop in the Material tab): offset of
  // the board's bottom-left corner from the work origin (= blank corner AT
  // anchor 1), in mm. The work origin itself NEVER moves — the offset shifts
  // every operation in the generated G-code instead.
  placement: {
    offsetX: 0,
    offsetY: 0,
  },

  // External vacuum / air cleaner on the Carvera Air EXTERNAL CONTROL PORT
  // (switch.extendout, M851/M852 — see web/public/machine-commands.js for the
  // firmware evidence). When enabled, every generated program switches the
  // port on after the spindle start and off after the program end, with a
  // dwell (G4) run-on so dust still in the air gets collected.
  vacuum: {
    enable: true, // automation on by default
    lingerSec: VACUUM_LINGER_DEFAULT_S, // run-on after the job (G4 P<sec>)
    pauseToolChange: false, // switch off while an M6 waits for the tool swap
    laser: true, // also run during the separate laser program
  },

  isolation: {
    tool: 'vbit', // 'vbit' | 'endmill'
    vbitAngleDeg: 30, // full included angle
    tipWidth: 0.2, // mm flat at the very tip (PCB pack: V-Bit 30° 0.2 mm)
    endmillDiameter: 0.2, // used when tool === 'endmill'
    cutDepth: 0.15, // mm into copper/FR4
    passes: 2, // number of concentric isolation passes
    overlap: 0.4, // fraction of tool width overlapped between passes
    feedXY: 300, // mm/min
    plungeFeed: 120, // mm/min
    rpm: 12000,
  },

  drill: {
    strategy: 'drill', // 'drill' (plunge with matching bit) | 'mill' (helical)
    throughMargin: 0.3, // extra depth below material to break through
    peck: 0.6, // mm per peck
    plungeFeed: 60, // mm/min
    rpm: 10000,
    // Optional remap of Excellon diameters (mm) to the bit you actually own.
    // e.g. [{ from: 1.3, to: 1.2 }]
    remap: [],
  },

  outline: {
    cutterDiameter: 2.0, // PCB pack: Spiral-O Single Flute 2 mm
    depthPerPass: 0.4, // mm per pass
    throughMargin: 0.2, // extra depth below material bottom on the final pass
    feedXY: 250, // mm/min
    plungeFeed: 80, // mm/min
    rpm: 12000,
    tabs: 4, // holding tabs so the board does not break free
    tabWidth: 2.0, // mm along the cut
    tabHeight: 0.4, // mm of material left under each tab (measured from stock bottom)
    climb: true, // climb vs conventional milling direction
    offsetSide: 'outside', // cut on the outside of the profile line
  },

  // Copper-area clearing (background pour removal): mill AWAY all remaining
  // background copper so only the traces remain (like a fully etched board),
  // using a flat endmill / corn bit with a concentric-offset pocket fill.
  clearing: {
    enable: false, // opt-in, like laser/solderMask
    toolDiameter: 2.0, // PCB pack: TiN Corn Bit 2 mm
    stepoverFrac: 0.4, // fraction of tool diameter overlapped between passes
    cutDepth: 0.12, // mm into copper/FR4 (copper is ~0.035 mm)
    margin: 0.4, // keep this far inside the board edge (don't touch the outline)
    gap: 0.1, // extra clearance kept around traces beyond the isolation channel
    feedXY: 500, // mm/min
    plungeFeed: 300, // mm/min
    rpm: 12000,
  },

  laser: {
    enable: false, // engrave the silkscreen with the 5W laser module
    // Makera "Speeds & Feeds" for PCB silk on soldermask: ~20% power (light) /
    // 30% (dark), ~100 mm/min, single pass. Adjust for bare-board marking.
    power: 0.2, // S value 0..1 (Smoothie laser power) applied on cutting moves
    feedXY: 100, // mm/min engraving feed
    passes: 1, // number of engraving passes
    // The Carvera calibrates the laser focus so that Z0 is the focus plane;
    // laser mode is entered with M321 and left with M322.
  },

  solderMask: {
    enable: false, // include the UV solder-mask steps in the guided workflow
    // (apply UV paint -> cure -> mill it off the pads with the removal bit)
  },
};

export function mergeConfig(base, override = {}) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = { ...out[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Effective cutting width of the isolation tool at the configured cut depth.
// For a V-bit this grows with depth; for an end mill it is the diameter.
export function isolationToolWidth(iso) {
  if (iso.tool === 'endmill') return iso.endmillDiameter;
  const half = (iso.vbitAngleDeg / 2) * (Math.PI / 180);
  return iso.tipWidth + 2 * iso.cutDepth * Math.tan(half);
}
