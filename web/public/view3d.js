// 3D board viewer built on three.js. Renders the FR4 body, copper (with holes),
// silkscreen, drill holes and the isolation/outline toolpaths, with orbit
// controls. Fed by the same `preview` payload the 2D canvas uses.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const COL = {
  fr4: 0xbda06a,
  copper: 0xd9822b,
  silk: 0xf2f2f2,
  drill: 0x0a0d12,
  iso: 0xff5a5a,
  out: 0x2ecc71,
  laser: 0xff59d8,
  bg: 0x0b0f16,
};

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Group flat rings into THREE.Shapes, nesting holes into their parent outer.
function buildShapes(rings, cx, cy) {
  const items = rings
    .map((r) => ({ ring: r, area: ringArea(r), abs: Math.abs(ringArea(r)) }))
    .sort((a, b) => b.abs - a.abs);
  const outers = [];
  for (const it of items) {
    const p0 = it.ring[0];
    const parents = outers.filter((o) => pointInRing(p0, o.ring));
    if (parents.length) {
      parents.sort((a, b) => a.abs - b.abs);
      const path = new THREE.Path(it.ring.map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
      parents[0].shape.holes.push(path);
    } else {
      const shape = new THREE.Shape(it.ring.map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
      outers.push({ ring: it.ring, abs: it.abs, shape });
    }
  }
  return outers.map((o) => o.shape);
}

export class Viewer3D {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COL.bg);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(40, 120, 60);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xafc4ff, 0.5);
    dir2.position.set(-60, 40, -40);
    this.scene.add(dir2);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.layers = { copper: true, silk: true, isolation: true, drills: true, outline: true, laser: true };
    this._running = false;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  setData(preview) {
    this._clearGroup();
    const { board, thickness } = preview;
    const w = board.width;
    const h = board.height;
    const t = thickness || 1.6;
    const cx = w / 2;
    const cy = h / 2;
    const topY = t / 2;

    // FR4 body
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, t, h),
      new THREE.MeshStandardMaterial({ color: COL.fr4, roughness: 0.85, metalness: 0.05 }),
    );
    this.group.add(body);

    // helper to lay a flat ShapeGeometry on the top plane
    const layFlat = (mesh, y) => {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = y;
    };

    // copper
    this.copperMesh = new THREE.Group();
    const copperMat = new THREE.MeshStandardMaterial({ color: COL.copper, roughness: 0.35, metalness: 0.75 });
    for (const shape of buildShapes(preview.copper || [], cx, cy)) {
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), copperMat);
      layFlat(m, topY + 0.01);
      this.copperMesh.add(m);
    }
    this.group.add(this.copperMesh);

    // silk
    this.silkMesh = new THREE.Group();
    const silkMat = new THREE.MeshStandardMaterial({ color: COL.silk, roughness: 0.9, metalness: 0 });
    for (const shape of buildShapes(preview.silk || [], cx, cy)) {
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), silkMat);
      layFlat(m, topY + 0.03);
      this.silkMesh.add(m);
    }
    this.group.add(this.silkMesh);

    // drills (dark cylinders through the board)
    this.drillMesh = new THREE.Group();
    const drillMat = new THREE.MeshStandardMaterial({ color: COL.drill, roughness: 0.6 });
    for (const d of preview.drills || []) {
      const geo = new THREE.CylinderGeometry(d.d / 2, d.d / 2, t * 1.25, 20);
      const m = new THREE.Mesh(geo, drillMat);
      m.position.set(d.x - cx, 0, -(d.y - cy));
      this.drillMesh.add(m);
    }
    this.group.add(this.drillMesh);

    // toolpaths
    this.isoMesh = this._lines(flattenRings(preview.isolation), cx, cy, topY + 0.08, COL.iso);
    this.group.add(this.isoMesh);
    this.outMesh = this._lines(
      (preview.outline || []).map((l) => l.pts.map((p) => [p.x, p.y])),
      cx,
      cy,
      topY + 0.1,
      COL.out,
      true,
    );
    this.group.add(this.outMesh);

    // laser (silkscreen engraving) paths
    this.laserMesh = this._lines(preview.laser || [], cx, cy, topY + 0.12, COL.laser, false);
    this.group.add(this.laserMesh);

    this._fit(Math.max(w, h), t);
    this.setLayers(this.layers);
    this.start();
  }

  _lines(rings, cx, cy, y, color, close = true) {
    const grp = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color });
    for (const ring of rings) {
      if (!ring || ring.length < 2) continue;
      const pts = ring.map(([x, yy]) => new THREE.Vector3(x - cx, y, -(yy - cy)));
      if (close) pts.push(pts[0].clone());
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    return grp;
  }

  _fit(maxDim, t) {
    const d = maxDim * 1.1 + 20;
    this.camera.position.set(maxDim * 0.15, d * 0.7, d * 0.75);
    this.camera.near = 0.1;
    this.camera.far = d * 6;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  setLayers(layers) {
    this.layers = { ...this.layers, ...layers };
    if (this.copperMesh) this.copperMesh.visible = this.layers.copper;
    if (this.silkMesh) this.silkMesh.visible = this.layers.silk;
    if (this.drillMesh) this.drillMesh.visible = this.layers.drills;
    if (this.isoMesh) this.isoMesh.visible = this.layers.isolation;
    if (this.outMesh) this.outMesh.visible = this.layers.outline;
    if (this.laserMesh) this.laserMesh.visible = this.layers.laser;
  }

  _clearGroup() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      disposeDeep(child);
    }
  }

  resize() {
    const w = this.container.clientWidth || 800;
    const hh = this.container.clientHeight || 460;
    this.renderer.setSize(w, hh, false);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.resize();
    const loop = () => {
      if (!this._running) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}

function flattenRings(passes) {
  const out = [];
  for (const pass of passes || []) for (const ring of pass) out.push(ring);
  return out;
}

// ---------------------------------------------------------------------------
// Auto-leveling height-map viewer: colour-coded 3D surface of the probed grid
// (green = flat, red = strong deviation), board outline at Z0, axis labels in
// mm and a hover tooltip with the value of the nearest probe point. Fed by
// the map object from web/public/height-map.js (parseLevelingFromLog).
// ---------------------------------------------------------------------------

function heightHue(z, scaleMm) {
  const t = Math.max(0, Math.min(1, Math.abs(z) / (scaleMm || 1)));
  return (120 - 120 * t) / 360; // green → yellow → red
}

function makeTextSprite(text, { size = 44, color = '#c7cede' } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `${size}px system-ui, sans-serif`;
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 12;
  canvas.height = size + 12;
  const c2 = canvas.getContext('2d');
  c2.font = font;
  c2.fillStyle = color;
  c2.textBaseline = 'top';
  c2.fillText(text, 6, 6);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const s = 0.09;
  sprite.scale.set(canvas.width * s, canvas.height * s, 1);
  return sprite;
}

export class HeightMapViewer3D {
  constructor(container, { tooltipEl = null, warnMm = 0.4 } = {}) {
    this.container = container;
    this.tooltipEl = tooltipEl;
    this.warnMm = warnMm;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COL.bg);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(40, 120, 60);
    this.scene.add(dir);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points = { threshold: 2.5 };
    this.pointer = new THREE.Vector2();
    this._onMove = (e) => this._hover(e);
    this.renderer.domElement.addEventListener('pointermove', this._onMove);
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._running = false;
  }

  // map: { cols, rows, xSize, ySize, points: [{col,row,x,y,z}], maxDeviation }
  setData(map) {
    this._clear();
    this.map = map;
    const { cols, rows, xSize, ySize } = map;
    const scaleMm = Math.max(this.warnMm, map.maxDeviation || 0.001);
    // vertical exaggeration so sub-mm deviations stay visible next to a
    // 100+ mm board — the tooltip/labels always show REAL mm.
    const zScale = Math.max(4, Math.min(60, (Math.min(xSize, ySize) * 0.35) / scaleMm));
    this.zScale = zScale;
    const cx = xSize / 2;
    const cy = ySize / 2;

    // surface: plane with per-vertex height + colour. PlaneGeometry vertex
    // rows run top→bottom, our grid rows run front (y=0) → back.
    const geo = new THREE.PlaneGeometry(xSize, ySize, cols - 1, rows - 1);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const color = new THREE.Color();
    const zAt = (col, row) => {
      const v = map.grid[row * cols + col];
      return Number.isFinite(v) ? v : 0;
    };
    for (let i = 0; i < pos.count; i++) {
      const col = i % cols;
      const vRow = Math.floor(i / cols); // 0 = top of the plane (back of the board)
      const row = rows - 1 - vRow;
      const z = zAt(col, row);
      pos.setZ(i, z * zScale);
      color.setHSL(heightHue(z, scaleMm), 0.85, 0.5);
      colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide,
    }));
    mesh.rotation.x = -Math.PI / 2; // plane XY → world XZ, height up
    this.group.add(mesh);
    const wire = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: 0x0b0f16, wireframe: true, transparent: true, opacity: 0.25 }));
    wire.rotation.x = -Math.PI / 2;
    this.group.add(wire);

    // probe points (raycast targets for the tooltip)
    const ppos = [];
    for (const p of map.points) ppos.push(p.x - cx, p.z * zScale + 0.15, -(p.y - cy));
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ppos), 3));
    this.points = new THREE.Points(pgeo, new THREE.PointsMaterial({ color: 0xe8edf6, size: 2.2 }));
    this.group.add(this.points);

    // board outline (= scanned area) at Z0
    const outline = [
      new THREE.Vector3(-cx, 0, cy), new THREE.Vector3(cx, 0, cy),
      new THREE.Vector3(cx, 0, -cy), new THREE.Vector3(-cx, 0, -cy), new THREE.Vector3(-cx, 0, cy),
    ];
    this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(outline), new THREE.LineBasicMaterial({ color: 0x4c8dff })));

    // axis labels in mm (origin = front-left = work origin)
    const l0 = makeTextSprite('0/0'); l0.position.set(-cx - 4, 0.5, cy + 4); this.group.add(l0);
    const lx = makeTextSprite(`X ${xSize.toFixed(1)} mm`); lx.position.set(cx + 6, 0.5, cy + 4); this.group.add(lx);
    const ly = makeTextSprite(`Y ${ySize.toFixed(1)} mm`); ly.position.set(-cx - 6, 0.5, -cy - 4); this.group.add(ly);
    const zMin = Math.min(...map.points.map((p) => p.z));
    const zMax = Math.max(...map.points.map((p) => p.z));
    const lz = makeTextSprite(`Z ${zMin.toFixed(3)} … ${zMax.toFixed(3)} mm`, { color: '#ffd23f' });
    lz.position.set(0, Math.max(zMax, 0) * zScale + 7, cy + 5);
    this.group.add(lz);

    const d = Math.max(xSize, ySize);
    this.camera.position.set(-d * 0.35, d * 0.7, d * 1.05);
    this.camera.far = d * 8 + 200;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.start();
  }

  _hover(e) {
    if (!this.points || !this.map || !this.tooltipEl) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.points);
    if (hits.length) {
      const p = this.map.points[hits[0].index];
      if (p) {
        this.tooltipEl.textContent = `X ${p.x.toFixed(1)} · Y ${p.y.toFixed(1)} · Z ${p.z.toFixed(3)} mm`;
        this.tooltipEl.style.left = `${e.clientX - rect.left + 12}px`;
        this.tooltipEl.style.top = `${e.clientY - rect.top - 8}px`;
        this.tooltipEl.classList.remove('hidden');
        return;
      }
    }
    this.tooltipEl.classList.add('hidden');
  }

  _clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      disposeDeep(child);
    }
    this.points = null;
  }

  resize() {
    const w = this.container.clientWidth || 700;
    const h = this.container.clientHeight || 420;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.resize();
    const loop = () => {
      if (!this._running) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  dispose() {
    this.stop();
    this._clear();
    this.renderer.domElement.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}

function disposeDeep(obj) {
  obj.traverse?.((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
}

// Expose to the (non-module-bundled) app without requiring dynamic import,
// which some embedded browsers block. If three.js fails to load, this module
// simply never assigns the globals and the 2D app keeps working (the height
// map then falls back to the 2D heatmap canvas).
window.MakeraViewer3D = Viewer3D;
window.MakeraHeightMap3D = HeightMapViewer3D;
