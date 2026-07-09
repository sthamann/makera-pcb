// OpenAI-assisted configuration review with a precise, baked-in knowledge base
// about the Makera Carvera Air, its tools, the PCB blanks, and the exact meaning
// of every configuration value. This keeps the model consistent and stops it
// from inventing bogus "issues".
//
// The prompt builder and response parser are pure functions (unit tested); the
// network call lives in reviewConfig().

// --- domain knowledge (accurate, sourced from Makera docs/toolkit) ----------
const KNOWLEDGE = `MACHINE — Makera Carvera Air (desktop 3-axis CNC):
- Spindle up to ~15000 rpm, standard 1/8" (3.175 mm) collet (S2). Manual QUICK
  tool change: M6 T<n> pauses for a bit swap, then the Air AUTO-MEASURES tool
  length at the sensor, so Z stays consistent across tools (T0 = wired probe,
  T-1 = none). Auto Z-probe (G38.2) and auto-leveling/height-map (G32 or the
  combined M495 auto command) using the WIRED PROBE. M370 clears the height map.
- Optional 5 W diode laser module for engraving (enters laser mode with M321,
  focus plane at Z0, engraves with G1 + S power 0..1, exits with M322).
- Good for single-sided PCB isolation milling on copper-clad FR4.

MAKERA TOOLKIT / PCB PACK + official PCB speeds&feeds (RPM / Feed mm/min /
PlungeFeed / DepthOfCut):
- V-Bit 1/8" 30°0.2 mm & 60°0.1 mm — isolation: 12000 rpm, feed 500, plunge 200,
  DOC 0.1.
- Corn bits (fishtail) 0.8–3.175 mm — area clearing / drilling / profile: 12000
  rpm, feed 500, plunge 300, DOC 0.3.
- PCB drill bits (0.8/1.0/1.2 mm …): 10000 rpm, feed 1000, plunge 200, DOC 1.
- UV solder-mask removal bit (0.3 mm 30°): 6000 rpm, feed 400, plunge 200, DOC 0.2.
- Laser PCB silk on soldermask: ~100 mm/min, power ~20% (light) / 30% (dark), 1 pass.
- PCB pack: copper-clad FR4 blanks (Makera blanks 1.5 mm; generic 1.6 mm; 1 oz =
  35 µm copper), UV-curable solder mask paint + roller + UV lamp, sanding block,
  alcohol wipes.

PCB WORKFLOW (Makera LED example): fixate PCB+wasteboard flat at anchor 1, set
work offset (e.g. X15/Y10), enable Scan Margin + Auto-Leveling (5×5 grid, height
2 mm) using the wired probe, then run isolation → area cleaning → drilling →
contour; the combined .nc auto-changes tools (wired probe, then bits).

PCB ISOLATION MILLING LOGIC:
- Isolation removes a thin channel AROUND conductors. The isolation tool's
  effective cutting width MUST be SMALLER than the smallest copper gap so
  adjacent features are electrically separated. Tool width < gap = GOOD; only
  tool width >= gap is a problem.
- cutDepth is how deep the tool cuts into copper/FR4: copper is only ~0.035 mm,
  so 0.05-0.20 mm is normal and correct (small is expected, not "too shallow").
- Outline/profile must cut fully through the board: depthPerPass 0.3-0.6 mm per
  pass, total (material thickness + ~0.2 mm) reached over several passes, leaving
  holding tabs so the board does not break free.
- Drilling depth = material thickness + small margin so it breaks through.

CONFIG FIELD SEMANTICS (do not misread these):
- safeZ = HIGH rapid clearance above the stock and top clamps (e.g. 12 mm on Carvera Air).
- travelZ = LOW hop height between nearby features on the same board; it MUST be
  LESS than safeZ and just above the surface (e.g. 2 mm). travelZ < safeZ is CORRECT.
- isolation.tipWidth = V-bit flat tip width (mm); isolation.vbitAngleDeg = included
  angle; effective width = tipWidth + 2*cutDepth*tan(angle/2).
- overlap = fraction of tool width overlapped between isolation passes (0..0.9).
- outline.tabs/tabWidth/tabHeight = holding tabs. drill.peck = peck depth per bite.
- Feeds are mm/min, rpm is spindle speed, laser.power is 0..1.`;

const SCHEMA_HINT = `Config schema (only include keys you actually want to change in "patch"):
{
  "material": { "thickness": number(mm) },
  "safeZ": number, "travelZ": number,
  "isolation": { "tool": "vbit"|"endmill", "vbitAngleDeg": number, "tipWidth": number,
                 "endmillDiameter": number, "cutDepth": number, "passes": int,
                 "overlap": 0..0.9, "feedXY": number, "plungeFeed": number, "rpm": number },
  "drill": { "throughMargin": number, "peck": number, "plungeFeed": number, "rpm": number },
  "outline": { "cutterDiameter": number, "depthPerPass": number, "throughMargin": number,
               "feedXY": number, "plungeFeed": number, "rpm": number, "tabs": int,
               "tabWidth": number, "tabHeight": number, "offsetSide": "outside"|"on"|"inside" },
  "laser": { "enable": bool, "power": 0..1, "feedXY": number, "passes": int }
}`;

export function buildReviewMessages({ config, board, checks, operations, stats }) {
  const context = {
    board,
    minCopperGap_mm: stats?.minCopperGap ?? null,
    isolationRings: stats?.isolationRings ?? null,
    drillGroups: stats?.drillGroups ?? [],
    operations: (operations || []).map((o) => ({ id: o.id, toolType: o.toolType, diameter: o.diameter })),
    existingChecks: (checks?.messages || []).map((m) => ({ level: m.level, text: m.text })),
    config,
  };

  const system =
    'You are a meticulous, consistent CNC/PCB process engineer for the Makera ' +
    'Carvera Air. Use ONLY the knowledge and constraints below. Be deterministic: ' +
    'given the same input, always return the same verdict. Do NOT invent problems. ' +
    'Flag an issue ONLY when a value actually violates a stated numeric constraint ' +
    'or is physically unsafe; otherwise say it is fine. Never contradict the field ' +
    'semantics (e.g. travelZ is SUPPOSED to be smaller than safeZ; an isolation ' +
    'tool narrower than the smallest copper gap is CORRECT, not a problem). If ' +
    'everything is within constraints, return an empty "issues" array and an empty ' +
    '"patch". Keep messages short and specific with the exact numbers.\n\n' +
    KNOWLEDGE +
    '\n\nReturn STRICT JSON only: {"summary": string, "issues": [{"severity": ' +
    '"error"|"warn"|"ok", "message": string}], "patch": object}. The patch is a ' +
    'partial config using this schema; omit keys that should not change:\n' +
    SCHEMA_HINT;

  const user =
    'Review this Carvera Air PCB milling job. Only suggest changes that are truly ' +
    'needed; if the config is already sound, return no issues and an empty patch.\n\n' +
    JSON.stringify(context, null, 2);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Extract the JSON object from a model response (handles code fences / stray text).
export function parseReview(text) {
  if (!text) throw new Error('empty AI response');
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object in AI response');
  const obj = JSON.parse(s.slice(start, end + 1));
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    issues: Array.isArray(obj.issues) ? obj.issues : [],
    patch: obj.patch && typeof obj.patch === 'object' ? obj.patch : {},
  };
}

// Flatten a nested patch into { "isolation.cutDepth": 0.12, ... } for the UI.
export function flattenPatch(patch, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenPatch(v, key));
    else out[key] = v;
  }
  return out;
}

// Robust OpenAI Chat Completions call that works across gpt-4o and gpt-5.x
// (reasoning) models: it tries the ideal request and progressively falls back on
// 400 errors (some models reject temperature / response_format / reasoning_effort).
async function chatCompletion({ apiKey, model, messages }) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const isReasoning = /^(gpt-5|o[0-9])/.test(model);
  const attempts = [
    {
      model, messages,
      response_format: { type: 'json_object' },
      ...(isReasoning ? { reasoning_effort: 'medium' } : { temperature: 0.1 }),
    },
    { model, messages, response_format: { type: 'json_object' } },
    { model, messages },
  ];
  let lastErr = 'OpenAI request failed';
  for (const body of attempts) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const errText = await res.text().catch(() => '');
    lastErr = `OpenAI ${res.status}: ${errText.slice(0, 300)}`;
    if (res.status !== 400) break; // 401/403/429/5xx: don't retry variants
  }
  throw new Error(lastErr);
}

// --- machine-log diagnosis --------------------------------------------------
// Build a prompt that turns the Carvera's send/receive log + the current job into
// a plain-language diagnosis and concrete next steps / G-code to try.
const MACHINE_CODES = `CARVERA / CARVERA AIR CONTROL CODES the operator can send:
- M6 T0 = full tool change to the wireless probe (ATC). M6 T-1 = drop tool. M6 T1..T6 = a tool.
- M493.2 T0 = SET the current tool NUMBER to the probe WITHOUT any ATC/movement
  (use when the tool number is wrong, e.g. stuck at T6 while the probe is in).
- "ATC already begun" = a tool-change (ATC) is stuck/mid-cycle → send a Reset
  (Ctrl-X / realtime 0x18) to abort, then retry. Homing ($H / M490) may be needed.
- M495 X.. Y.. C.. D.. O0 A.. B.. I.. J.. H2 P1 = combined Scan-Margin + Z-probe +
  Auto-Leveling (needs the probe as the active tool = T0, else it prints
  "Change to probe tool first!").
- $H home, $X unlock (clear alarm), G10 L20 P0 X0 Y0 = set current pos as work origin,
  M496.1 clearance, M496.2 goto work origin, M490.1/.2 collet close/open, M491 calibrate,
  M370 clear height map, M375.1 show height map.
- On the Air the probe is wireless (placed by hand): prefer M493.2 T0 to register it.`;

export function buildDiagnoseMessages({ log, config, board, stats }) {
  const tail = Array.isArray(log) ? log.slice(-60).join('\n') : String(log || '').split('\n').slice(-60).join('\n');
  const context = {
    board: board || null,
    currentTool: stats?.tool ?? null,
    isolationRings: stats?.isolationRings ?? null,
    machine_log_tail: tail,
    config: config || null,
  };
  const system =
    'You are a Makera Carvera Air CNC support engineer. Read the machine send/receive ' +
    'log and the current job, find the MOST LIKELY reason the operation is not working, ' +
    'and give short, concrete next steps (and exact G-code to send when useful). Be ' +
    'specific to what the log actually shows; do not invent problems. Prefer the least ' +
    'destructive fix. Use ONLY these facts:\n\n' + KNOWLEDGE + '\n\n' + MACHINE_CODES +
    '\n\nReturn STRICT JSON only: {"summary": string, "cause": string, "fixSteps": ' +
    '[string], "commands": [string]} — commands are raw G/M-code lines the operator can ' +
    'send (may be empty). Keep it concise.';
  const user =
    'Diagnose this Carvera Air situation and tell me how to fix it:\n\n' +
    JSON.stringify(context, null, 2);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function parseDiagnose(text) {
  if (!text) throw new Error('empty AI response');
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object in AI response');
  const obj = JSON.parse(s.slice(start, end + 1));
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    cause: typeof obj.cause === 'string' ? obj.cause : '',
    fixSteps: Array.isArray(obj.fixSteps) ? obj.fixSteps.filter((x) => typeof x === 'string') : [],
    commands: Array.isArray(obj.commands) ? obj.commands.filter((x) => typeof x === 'string') : [],
  };
}

export async function diagnoseLog({ apiKey, model, log, config, board, stats }) {
  if (!apiKey) throw new Error('OpenAI API key required');
  const messages = buildDiagnoseMessages({ log, config, board, stats });
  const data = await chatCompletion({ apiKey, model: model || 'gpt-5.5', messages });
  const content = data?.choices?.[0]?.message?.content || '';
  const out = parseDiagnose(content);
  out.model = model || 'gpt-5.5';
  return out;
}

export async function reviewConfig({ apiKey, model, config, board, checks, operations, stats }) {
  if (!apiKey) throw new Error('OpenAI API key required');
  const messages = buildReviewMessages({ config, board, checks, operations, stats });
  const data = await chatCompletion({ apiKey, model: model || 'gpt-5.5', messages });
  const content = data?.choices?.[0]?.message?.content || '';
  const review = parseReview(content);
  review.flatPatch = flattenPatch(review.patch);
  review.model = model || 'gpt-5.5';
  return review;
}
