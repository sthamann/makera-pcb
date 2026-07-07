// File discovery helpers: pick copper / edge-cuts / drill / silkscreen files
// out of a KiCad gerber export folder.

import fs from 'node:fs';
import path from 'node:path';

const PATTERNS = {
  copper: [/f[_.]?cu/i, /\.gtl$/i],
  edge: [/edge[_.]?cuts/i, /\.gm1$/i, /\.gko$/i, /profile/i],
  drill: [/\.drl$/i, /-pth/i, /\.xln$/i, /\.nc$/i],
  silk: [/f[_.]?silk/i, /\.gto$/i],
};

function firstMatch(files, patterns) {
  for (const pat of patterns) {
    const hit = files.find((f) => pat.test(f));
    if (hit) return hit;
  }
  return null;
}

export function discoverFolder(dir) {
  const entries = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const pick = (role) => {
    const name = firstMatch(entries, PATTERNS[role]);
    return name ? path.join(dir, name) : null;
  };
  return {
    copper: pick('copper'),
    edge: pick('edge'),
    drill: pick('drill'),
    silk: pick('silk'),
  };
}

export function loadFolder(dir) {
  const paths = discoverFolder(dir);
  const read = (p) => (p ? fs.readFileSync(p, 'utf8') : null);
  return {
    paths,
    copper: read(paths.copper),
    edge: read(paths.edge),
    drill: read(paths.drill),
    silk: read(paths.silk),
  };
}
