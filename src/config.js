// Default job configuration tuned for the Makera Carvera Air milling FR4.
// Every value is overridable from the CLI/Web UI. Feeds/speeds are deliberately
// conservative starting points; verify on your machine and material.

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
  safeZ: 5.0, // rapid clearance above stock
  travelZ: 1.5, // low hop between nearby features

  isolation: {
    tool: 'vbit', // 'vbit' | 'endmill'
    vbitAngleDeg: 30, // full included angle
    tipWidth: 0.1, // mm flat at the very tip
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
    cutterDiameter: 1.0, // flat end mill for the board profile
    depthPerPass: 0.4, // mm per pass
    feedXY: 250, // mm/min
    plungeFeed: 80, // mm/min
    rpm: 12000,
    tabs: 4, // holding tabs so the board does not break free
    tabWidth: 2.0, // mm along the cut
    tabHeight: 0.4, // mm of material left under each tab
    climb: true, // climb vs conventional milling direction
    offsetSide: 'outside', // cut on the outside of the profile line
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
