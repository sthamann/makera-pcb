// Human-readable, step-by-step manufacturing guide (Markdown). It adapts to the
// enabled options (solder mask, laser) and to the assigned tools, and spells out
// exactly when to change tools, apply/cure/remove solder mask, dry, and cut tabs.

import { isolationToolWidth } from './config.js';

export function buildReport({ cfg, board, iso, drill, outline, checks, files, warnings, toolForOp, laserOn, silkPresent }) {
  const L = [];
  const p = (s = '') => L.push(s);
  const sm = !!cfg.solderMask?.enable;

  const toolLabel = (opId, fallback) => {
    const t = toolForOp ? toolForOp(opId) : null;
    if (t) return `**T${t.number}** – ${t.label || t.type + ' ' + t.diameter + ' mm'}`;
    return `${fallback} _(kein Werkzeug zugeordnet – im Werkzeug-Panel zuweisen)_`;
  };
  const isoTool = toolLabel('isolation',
    cfg.isolation.tool === 'endmill' ? `Flachfräser ${cfg.isolation.endmillDiameter} mm` : `V-Bit ${cfg.isolation.vbitAngleDeg}°/${cfg.isolation.tipWidth} mm`);
  const outTool = toolLabel('outline', `Fräser ${cfg.outline.cutterDiameter} mm`);

  p('# Fertigungs-Anleitung · Makera Carvera Air');
  p('');
  p(`Board **${board.width.toFixed(2)} × ${board.height.toFixed(2)} mm**, einseitig (Kupfer oben, kein Spiegeln). Material ${cfg.material.thickness} mm FR4.`);
  if (cfg.stock?.sizeX && cfg.stock?.sizeY) {
    p(`Rohling: **${cfg.stock.sizeX} × ${cfg.stock.sizeY} mm**, ${cfg.stock.sides === 'double' ? 'doppelseitig' : 'einseitig'} (Makera-Standard).`);
  }
  p(`Modus: ${sm ? '**mit UV-Lötstopplack**' : 'ohne Lötstopplack'}${laserOn ? ' · **mit Laser-Silkscreen**' : ''}.`);
  p('');

  // ---- Bill of materials / tools ----
  p('## Das brauchst du');
  p('');
  p('- Kupfer-Platine (FR4, ' + cfg.material.thickness + ' mm), etwas größer als das Board, plane Opferplatte, Klemmen/Klebeband');
  p('- ' + isoTool.replace(/\*\*/g, '') + ' (Isolation)');
  for (const g of drill.groups) p(`- Bohrer ${g.bitDiameter.toFixed(2)} mm (${g.holes.length}×)`);
  if (outline.loops.length) p('- ' + outTool.replace(/\*\*/g, '') + ' (Außenkontur)');
  if (sm) {
    p('- UV-Lötstopplack + Roller + UV-Lampe (Makera PCB-Pack), Schleifblock, Isopropanol/Alkoholtücher');
    p('- **Lötstopplack-Entfernungsfräser** (spring-loaded, Makera No.5) zum Freilegen der Pads');
  }
  if (laserOn) p('- Lasermodul 5 W + **Laserschutzbrille**');
  p('- Wireless-/Kabelsonde für Z-Antastung, Handsäge + Schleifblock für die Stege');
  p('');

  // ---- Setup ----
  p('## Vorbereitung');
  p('');
  p('1. Kupferplatine + **Opferplatte (MDF, 1–2 mm)** plan an die L-Ecke (**Ankerpunkt 1**) spannen (Doppelklebeband + Top-Klemmen, Rand für die Kontur frei lassen). Vorher Platine plandrücken.');
  p('2. **Werkstück-Nullpunkt (XY)** setzen – Makera-Standard-Offset **X15/Y10 ab Ankerpunkt 1**.');
  p('3. **Wired Probe (T0)** einsetzen (der Air fragt „Changing Tool: Probe").');
  p('4. **Config & Run** in einem Rutsch (wie im Makera-Dialog): **Scan Margin** + **Auto Z Probe** (Z0) + **Auto Leveling** (5×5, Höhe 2 mm) mit dem Wired Probe. Bei PCB Pflicht, sonst ungleiche Frästiefe.');
  p('5. **Erst danach** das Schneidwerkzeug einsetzen. Werkzeuglänge misst der Air bei jedem `M6` selbst – kein manuelles Z-Nachtasten pro Werkzeug.');
  p('');

  // ---- Guided steps ----
  p('## Ablauf – Schritt für Schritt');
  p('');
  let n = 1;
  const step = (title, lines) => { p(`### Schritt ${n++} · ${title}`); for (const l of lines) p(l); p(''); };

  step('Isolation fräsen', [
    `- ⏸ **Werkzeug einsetzen:** ${isoTool} (erst nach dem Leveling). Werkzeuglänge wird automatisch gemessen.`,
    `- Programm **${files.isolation}** laden (Höhenkarte bleibt aktiv), starten.`,
    `- Frästiefe ${cfg.isolation.cutDepth} mm, ${iso.passes.length} Bahn(en). Trennt die Leiterbahnen vom Restkupfer.`,
    '- Hinweis: Dieses Programm macht **Isolation** (Trennkanäle). Das Makera-Beispiel räumt zusätzlich das Restkupfer flächig ab („Area Cleaning") – für die Funktion nicht nötig, nur optisch/HF-relevant.',
  ]);

  if (sm) {
    step('Reinigen & anschleifen', [
      '- Board mit Isopropanol reinigen und mit dem Schleifblock leicht anschleifen (Grate weg, bessere Haftung).',
    ]);
    step('UV-Lötstopplack auftragen & aushärten', [
      '- 🖌️ **Lack auftragen:** mit dem Roller eine **dünne, gleichmäßige** Schicht UV-Lack aufrollen. _Lieber zu wenig als zu viel – zu dick lässt sich schwer entfernen._',
      '- 💡 **Aushärten:** UV-Lampe über das Board, bis der Lack **komplett fest** ist (Zeit variiert je nach Lack/Lampe, oft 5–15 min).',
      '- Roller und Werkzeuge sofort mit Alkohol reinigen.',
    ]);
    step('Lötstopplack von den Pads entfernen', [
      '- ⏸ **Werkzeug wechseln:** Lötstopplack-Entfernungsfräser (No.5, spring-loaded). Z sorgfältig antasten (bei Federfräser ggf. manuell auf Z0 über dem Board setzen).',
      '- Freilegt nur die Pad-/Bohrflächen, damit sie lötbar sind.',
    ]);
  }

  for (const g of drill.groups) {
    const t = toolLabel(`drill:${g.bitDiameter.toFixed(2)}`, `Bohrer ${g.bitDiameter.toFixed(2)} mm`);
    step(`Bohren ${g.bitDiameter.toFixed(2)} mm (${g.holes.length}×)`, [
      `- ⏸ **Werkzeug wechseln:** ${t}. Z antasten.`,
      `- Programm **${files.drill[g.tool] || '(Bohrdatei)'}** laden, starten. Peck ${cfg.drill.peck} mm, Tiefe ${g.depth.toFixed(2)} mm.`,
    ]);
  }

  if (outline.loops.length) {
    step('Außenkontur schneiden', [
      `- ⏸ **Werkzeug wechseln:** ${outTool}. Z antasten.`,
      `- Programm **${files.outline}** laden, starten. ${cfg.outline.tabs} Haltestege lassen das Board bis zuletzt fixiert.`,
    ]);
  }

  if (laserOn) {
    step('Silkscreen mit Laser gravieren', [
      '- ⚠️ **Laserschutzbrille aufsetzen.** ⏸ Lasermodul einsetzen (Kabel an 3-Pin-Buchse).',
      `- Programm **${files.laser}** laden. \`M321\` schaltet in den Lasermodus (Fokus Z0), gravierte Beschriftung mit ${Math.round((cfg.laser.power || 0) * 100)} % Leistung, \`M322\` beendet.`,
      sm ? '- Der Laser graviert die Beschriftung direkt auf den Lötstopplack.' : '- Ohne Lötstopplack graviert der Laser direkt aufs Board/Kupfer.',
    ]);
  }

  step('Entnehmen & finishen', [
    '- Board lösen, Haltestege mit der Handsäge durchtrennen, Kanten mit dem Schleifblock glätten.',
    '- Reinigen; Bauteile von oben bestücken und auf der Kupferseite verlöten.',
  ]);

  p('> Alternativ als **1-Datei-Job**: Sind allen Fräs-Schritten Werkzeuge zugeordnet, kannst du `0_full_job.nc` laden – die Maschine fordert per `M6` zu jedem Werkzeugwechsel auf und misst danach die Länge. (Lack-Schritte und Laser laufen separat.)');
  p('');

  // ---- Feeds/speeds ----
  p('## Werkzeuge & Parameter');
  p('');
  p('| Schritt | Werkzeug | Tiefe | Vorschub XY | Drehzahl |');
  p('|---|---|---|---|---|');
  p(`| Isolation | ${stripBold(isoTool)} (eff. ${isolationToolWidth(cfg.isolation).toFixed(3)} mm) | ${cfg.isolation.cutDepth} mm | ${effFeed('isolation')} | ${effRpm('isolation', cfg.isolation.rpm)} |`);
  for (const g of drill.groups) {
    const opId = `drill:${g.bitDiameter.toFixed(2)}`;
    p(`| Bohren ${g.bitDiameter.toFixed(2)} mm | ${stripBold(toolLabel(opId, '–'))} | ${g.depth.toFixed(2)} mm | – | ${effRpm(opId, cfg.drill.rpm)} |`);
  }
  if (outline.loops.length) {
    const outDepth = (cfg.material.thickness + 0.2).toFixed(2);
    p(`| Außenkontur | ${stripBold(outTool)} | ${outDepth} mm (${cfg.outline.tabs} Tabs) | ${effFeed('outline')} | ${effRpm('outline', cfg.outline.rpm)} |`);
  }
  if (laserOn) p(`| Laser Silkscreen | Laser 5 W | – | ${cfg.laser.feedXY} mm/min | ${Math.round((cfg.laser.power || 0) * 100)} % |`);
  p('');

  function effFeed(opId) {
    const t = toolForOp ? toolForOp(opId === 'isolation' ? 'isolation' : opId) : null;
    if (t && t.feedXY != null) return `${t.feedXY} mm/min`;
    return `${opId === 'isolation' ? cfg.isolation.feedXY : cfg.outline.feedXY} mm/min`;
  }
  function effRpm(opId, fallback) {
    const t = toolForOp ? toolForOp(opId) : null;
    return `${t && t.rpm != null ? t.rpm : fallback} rpm`;
  }

  // ---- Checks ----
  p('## Fräsbarkeits-Check');
  p('');
  for (const m of checks.messages) {
    const tag = m.level === 'error' ? '⛔' : m.level === 'warn' ? '⚠️' : '✅';
    p(`- ${tag} ${m.text}`);
  }
  p('');

  if (warnings.length) {
    p('## Hinweise');
    p('');
    for (const w of warnings) p(`- ${w}`);
    p('');
  }

  p('---');
  p('_Feeds/Speeds sind Startwerte – an Maschine und Material anpassen. Auto-Leveling für PCB dringend empfohlen._');
  return L.join('\n') + '\n';
}

function stripBold(s) {
  return s.replace(/\*\*/g, '');
}
