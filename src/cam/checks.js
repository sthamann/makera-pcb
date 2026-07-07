// Manufacturability checks for isolation milling.

import { offsetClosed, outerContourCount, boundingBox } from '../geometry/clipper.js';
import { isolationToolWidth } from '../config.js';

// Estimate the smallest copper-to-copper gap by growing the copper outward and
// finding the offset at which two separate islands first merge. Merges are
// monotonic in the offset amount, so a binary search converges quickly.
export function estimateMinCopperGap(copperPolys, maxCheck = 1.5) {
  const initial = outerContourCount(copperPolys);
  if (initial <= 1) return { gap: null, islands: initial };

  const mergesAt = (delta) => outerContourCount(offsetClosed(copperPolys, delta)) < initial;

  // If even the largest probe does not merge anything, the gap is > 2*maxCheck.
  if (!mergesAt(maxCheck)) return { gap: 2 * maxCheck, islands: initial, atLeast: true };

  let lo = 0;
  let hi = maxCheck;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (mergesAt(mid)) hi = mid;
    else lo = mid;
  }
  return { gap: 2 * hi, islands: initial };
}

export function runChecks({ copperPolys, drill, outline, cfg, boardBounds }) {
  const messages = [];
  const add = (level, text) => messages.push({ level, text });

  const toolWidth = isolationToolWidth(cfg.isolation);
  const { gap, islands, atLeast } = estimateMinCopperGap(copperPolys);

  if (gap != null) {
    const gapStr = `${gap.toFixed(3)} mm${atLeast ? ' (≥)' : ''}`;
    if (gap < toolWidth) {
      add(
        'error',
        `Smallest copper gap ≈ ${gapStr} is narrower than the isolation tool width (${toolWidth.toFixed(3)} mm). Those features will NOT be separated. Use a finer V-bit / smaller tip or reduce cut depth.`,
      );
    } else if (gap < toolWidth * 1.5) {
      add(
        'warn',
        `Smallest copper gap ≈ ${gapStr} is close to the tool width (${toolWidth.toFixed(3)} mm). One pass will just clear it; extra passes may bridge into neighbours.`,
      );
    } else {
      add('ok', `Smallest copper gap ≈ ${gapStr} — comfortably millable with a ${toolWidth.toFixed(3)} mm tool.`);
    }
  } else {
    add('warn', `Copper forms a single connected island (${islands}); no isolation gap to measure. Check the layer selection.`);
  }

  // Board vs. stock size.
  if (boardBounds) {
    const w = boardBounds.maxX - boardBounds.minX;
    const h = boardBounds.maxY - boardBounds.minY;
    const stock = cfg.stock;
    if (stock && stock.sizeX && stock.sizeY) {
      const margin = 4; // mm clamping margin recommendation
      // The board can sit in either orientation on the blank.
      const fits =
        (w + margin <= stock.sizeX && h + margin <= stock.sizeY) ||
        (h + margin <= stock.sizeX && w + margin <= stock.sizeY);
      if (fits) {
        add('ok', `Board ${w.toFixed(1)} × ${h.toFixed(1)} mm passt auf den Rohling ${stock.sizeX} × ${stock.sizeY} mm (inkl. ~${margin} mm Spannrand).`);
      } else {
        add('error', `Board ${w.toFixed(1)} × ${h.toFixed(1)} mm passt NICHT auf den gewählten Rohling ${stock.sizeX} × ${stock.sizeY} mm (mit ~${margin} mm Spannrand). Größeren Rohling wählen.`);
      }
    } else {
      add('ok', `Board ≈ ${w.toFixed(2)} × ${h.toFixed(2)} mm. Rohling muss größer sein (Spannrand einplanen).`);
    }
  }

  // Drill sanity.
  for (const g of drill.groups) {
    if (g.bitDiameter < 0.3) {
      add('warn', `Drill group ${g.bitDiameter.toFixed(2)} mm is very small and fragile — peck slowly.`);
    }
  }
  if (drill.warnings) drill.warnings.forEach((w) => add('warn', w));

  // Isolation-pass width vs. gap (over-milling risk).
  if (gap != null && cfg.isolation.passes > 1) {
    const stepover = Math.max(0.01, toolWidth * (1 - cfg.isolation.overlap));
    const clearedWidth = toolWidth + (cfg.isolation.passes - 1) * stepover;
    if (clearedWidth > gap) {
      add(
        'warn',
        `With ${cfg.isolation.passes} passes the cleared channel (~${clearedWidth.toFixed(3)} mm) is wider than the smallest gap (${gap.toFixed(3)} mm); the outer pass will start cutting the neighbouring copper. Reduce passes or overlap.`,
      );
    }
  }

  if (outline.warnings) outline.warnings.forEach((w) => add('warn', w));

  return { messages, minCopperGap: gap, toolWidth };
}
