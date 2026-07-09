// Excellon drill file parser (KiCad flavour).
//
// Handles: METRIC/INCH, absolute/incremental, tool table (Tn C<dia>),
// tool selection (Tn), drilled points (X.. Y..) and routed slots
// (G00/G01 with a tool down between X../Y.. moves -> treated as a slot line).

export function parseExcellon(text) {
  const warnings = [];
  const tools = new Map(); // number -> diameter (mm)
  const holesByTool = new Map(); // number -> [{x,y}]
  const slotsByTool = new Map(); // number -> [{x1,y1,x2,y2}]

  let unit = 'mm';
  let absolute = true;
  let inHeader = false;
  let currentTool = null;
  let decimals = null; // inferred if coordinates are integer format
  let lastX = 0;
  let lastY = 0;
  let routing = false;
  let routeStart = null;

  const lines = text.split(/\r?\n/);

  function toMm(v) {
    return unit === 'in' ? v * 25.4 : v;
  }

  // Coordinate values may be decimal ("X9.0") or implicit-decimal integers
  // ("X0090000" with a format). KiCad's default export here uses explicit
  // decimals, but we support both.
  function coord(str) {
    if (str.includes('.')) return parseFloat(str);
    // integer form: apply implied decimals. KiCad's default is 2.4 for inch and
    // 3.3 for metric; real KiCad exports use explicit decimal points, so this is
    // only a fallback for integer-encoded files.
    const dec = decimals ?? (unit === 'in' ? 4 : 3);
    const neg = str.startsWith('-');
    const digits = neg ? str.slice(1) : str;
    const v = parseInt(digits, 10) / Math.pow(10, dec);
    return neg ? -v : v;
  }

  function ensureTool(n) {
    if (!holesByTool.has(n)) holesByTool.set(n, []);
    if (!slotsByTool.has(n)) slotsByTool.set(n, []);
  }

  function parseCoords(line) {
    const xm = line.match(/X([+-]?[\d.]+)/);
    const ym = line.match(/Y([+-]?[\d.]+)/);
    let nx = xm ? toMm(coord(xm[1])) : lastX;
    let ny = ym ? toMm(coord(ym[1])) : lastY;
    if (!absolute) {
      nx = lastX + (xm ? toMm(coord(xm[1])) : 0);
      ny = lastY + (ym ? toMm(coord(ym[1])) : 0);
    }
    return { nx, ny };
  }

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(';')) continue;

    if (line === 'M48') {
      inHeader = true;
      continue;
    }
    if (line === '%' || line === 'M95') {
      inHeader = false;
      continue;
    }
    if (line === 'METRIC' || line.startsWith('METRIC')) {
      unit = 'mm';
      continue;
    }
    if (line === 'INCH' || line.startsWith('INCH')) {
      unit = 'in';
      continue;
    }
    if (line === 'M71') {
      unit = 'mm';
      continue;
    }
    if (line === 'M72') {
      unit = 'in';
      continue;
    }
    if (line === 'G90') {
      absolute = true;
      continue;
    }
    if (line === 'G91') {
      absolute = false;
      continue;
    }
    if (line.startsWith('FMAT')) continue;
    if (line === 'M30' || line === 'M00' || line === 'M02') break;

    // Tool definition in header: T1C1.000
    const toolDef = line.match(/^T(\d+)C([\d.]+)/);
    if (inHeader && toolDef) {
      tools.set(Number(toolDef[1]), toMm(parseFloat(toolDef[2])));
      ensureTool(Number(toolDef[1]));
      continue;
    }

    // Tool select in body: T1
    const toolSel = line.match(/^T(\d+)\s*$/);
    if (!inHeader && toolSel) {
      currentTool = Number(toolSel[1]);
      ensureTool(currentTool);
      continue;
    }

    if (line.startsWith('G05') || line.startsWith('G01')) {
      routing = true;
      // fall through to parse any trailing coordinates on the same line
    }
    if (line.startsWith('G00')) {
      routing = false;
      routeStart = null;
      if (currentTool != null) {
        const { nx, ny } = parseCoords(line);
        lastX = nx;
        lastY = ny;
      }
      continue;
    }
    if (line.startsWith('M15')) {
      routing = true;
      routeStart = { x: lastX, y: lastY };
      continue;
    }
    if (line.startsWith('M16') || line.startsWith('M17')) {
      routing = false;
      routeStart = null;
      continue;
    }

    // KiCad alternate drill mode (G85) — routed slot between two points.
    const g85 = line.match(/X([+-]?[\d.]+)Y([+-]?[\d.]+)G85X([+-]?[\d.]+)Y([+-]?[\d.]+)/i);
    if (g85 && currentTool != null) {
      const x1 = toMm(coord(g85[1]));
      const y1 = toMm(coord(g85[2]));
      const x2 = toMm(coord(g85[3]));
      const y2 = toMm(coord(g85[4]));
      slotsByTool.get(currentTool).push({ x1, y1, x2, y2 });
      lastX = x2;
      lastY = y2;
      continue;
    }

    // Coordinate line: X..Y.. (either a drill hit or a routed move)
    const cm = line.match(/X([+-]?[\d.]+)?Y([+-]?[\d.]+)?|X([+-]?[\d.]+)|Y([+-]?[\d.]+)/);
    if (cm && currentTool != null) {
      const { nx, ny } = parseCoords(line);
      if (routing && routeStart) {
        slotsByTool.get(currentTool).push({ x1: routeStart.x, y1: routeStart.y, x2: nx, y2: ny });
        routeStart = { x: nx, y: ny };
      } else if (routing && line.startsWith('G01')) {
        slotsByTool.get(currentTool).push({ x1: lastX, y1: lastY, x2: nx, y2: ny });
      } else if (!line.startsWith('G00')) {
        holesByTool.get(currentTool).push({ x: nx, y: ny });
      }
      lastX = nx;
      lastY = ny;
      continue;
    }
  }

  const drills = [];
  for (const [n, dia] of tools) {
    drills.push({
      tool: n,
      diameter: dia,
      holes: holesByTool.get(n) || [],
      slots: slotsByTool.get(n) || [],
    });
  }
  drills.sort((a, b) => a.diameter - b.diameter);

  return { unit, drills, warnings };
}
