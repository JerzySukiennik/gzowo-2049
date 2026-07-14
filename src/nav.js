// nav.js — grid navigation for Gzowo 2049 robots: a 2m walkability grid over the
// playable area, A* (8-dir, corner-cutting prevented) with line-of-sight string
// pulling. Static obstacles (buildings) and dynamic walls (destroyed = walkable)
// are registered from the SAME collision data game.js uses. The player never uses
// this — only robot AI does.

const SQRT2 = Math.SQRT2;

let minX = -100, minZ = -100, cell = 2, inflate = 0.7;
let W = 0, H = 0, N = 0;

let staticBlock = new Uint8Array(0);
let wallBlock = new Uint16Array(0);
const wallCells = new Map();

let gScore = new Float32Array(0);
let fScore = new Float32Array(0);
let cameFrom = new Int32Array(0);
let seenGen = new Int32Array(0);
let closedGen = new Int32Array(0);
let curGen = 0;
const heap = [];

export function configure(opts) {
  minX = opts.minX;
  minZ = opts.minZ;
  cell = opts.cell;
  inflate = opts.inflate !== undefined ? opts.inflate : 0.7;
  W = Math.ceil((opts.maxX - opts.minX) / cell);
  H = Math.ceil((opts.maxZ - opts.minZ) / cell);
  N = W * H;
  staticBlock = new Uint8Array(N);
  wallBlock = new Uint16Array(N);
  wallCells.clear();
  gScore = new Float32Array(N);
  fScore = new Float32Array(N);
  cameFrom = new Int32Array(N);
  seenGen = new Int32Array(N);
  closedGen = new Int32Array(N);
  curGen = 0;
  heap.length = 0;
}

function ixOf(x) { return Math.floor((x - minX) / cell); }
function izOf(z) { return Math.floor((z - minZ) / cell); }
function idx(ix, iz) { return iz * W + ix; }
function cx(ix) { return minX + (ix + 0.5) * cell; }
function cz(iz) { return minZ + (iz + 0.5) * cell; }
function inBounds(ix, iz) { return ix >= 0 && ix < W && iz >= 0 && iz < H; }

function boxCells(box, out) {
  const ax = ixOf(box.minX - inflate), bx = ixOf(box.maxX + inflate);
  const az = izOf(box.minZ - inflate), bz = izOf(box.maxZ + inflate);
  const lox = Math.max(0, ax), hix = Math.min(W - 1, bx);
  const loz = Math.max(0, az), hiz = Math.min(H - 1, bz);
  // Block a cell only when its CENTER falls inside the inflated box. Any-overlap
  // blocking sealed the square's 3.5m corner gaps: the opening became a pure
  // diagonal and corner-cut prevention closed it entirely.
  for (let iz = loz; iz <= hiz; iz++) {
    const zc = cz(iz);
    if (zc < box.minZ - inflate || zc > box.maxZ + inflate) continue;
    for (let ix = lox; ix <= hix; ix++) {
      const xc = cx(ix);
      if (xc < box.minX - inflate || xc > box.maxX + inflate) continue;
      out.push(idx(ix, iz));
    }
  }
}

export function addObstacle(box) {
  const cells = [];
  boxCells(box, cells);
  for (let i = 0; i < cells.length; i++) staticBlock[cells[i]] = 1;
}

export function registerWall(id, box, destroyed) {
  const cells = [];
  boxCells(box, cells);
  const arr = Int32Array.from(cells);
  wallCells.set(id, arr);
  if (!destroyed) {
    for (let i = 0; i < arr.length; i++) wallBlock[arr[i]]++;
  }
}

export function setWallDestroyed(id, destroyed) {
  const arr = wallCells.get(id);
  if (!arr) return;
  if (destroyed) {
    for (let i = 0; i < arr.length; i++) { if (wallBlock[arr[i]] > 0) wallBlock[arr[i]]--; }
  } else {
    for (let i = 0; i < arr.length; i++) wallBlock[arr[i]]++;
  }
}

function cellWalkable(ix, iz) {
  if (!inBounds(ix, iz)) return false;
  const i = idx(ix, iz);
  return staticBlock[i] === 0 && wallBlock[i] === 0;
}

export function isWalkable(x, z) {
  return cellWalkable(ixOf(x), izOf(z));
}

function nearestWalkableCell(ix, iz) {
  if (cellWalkable(ix, iz)) return (iz * W + ix);
  for (let ring = 1; ring < 24; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      const az = iz + dz;
      const edge = Math.abs(dz) === ring;
      for (let dx = -ring; dx <= ring; dx++) {
        if (!edge && Math.abs(dx) !== ring) continue;
        const ax = ix + dx;
        if (cellWalkable(ax, az)) return idx(ax, az);
      }
    }
  }
  return -1;
}

// Grid line-of-sight: supercover traversal, corner-cut prevented at exact diagonals.
function cellLOS(x0, z0, x1, z1) {
  if (x0 === x1 && z0 === z1) return cellWalkable(x0, z0);
  let x = x0, z = z0;
  let dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
  const sx = x1 > x0 ? 1 : -1, sz = z1 > z0 ? 1 : -1;
  let err = dx - dz;
  let n = 1 + dx + dz;
  const ddx = dx * 2, ddz = dz * 2;
  for (; n > 0; n--) {
    if (!cellWalkable(x, z)) return false;
    if (err > 0) { x += sx; err -= ddz; }
    else if (err < 0) { z += sz; err += ddx; }
    else {
      if (!cellWalkable(x + sx, z) || !cellWalkable(x, z + sz)) return false;
      x += sx; z += sz; err -= ddz; err += ddx; n--;
    }
  }
  return true;
}

export function hasLineOfWalk(x0, z0, x1, z1) {
  return cellLOS(ixOf(x0), izOf(z0), ixOf(x1), izOf(z1));
}

function heapPush(i) {
  heap.push(i);
  let c = heap.length - 1;
  while (c > 0) {
    const p = (c - 1) >> 1;
    if (fScore[heap[p]] <= fScore[heap[c]]) break;
    const t = heap[p]; heap[p] = heap[c]; heap[c] = t;
    c = p;
  }
}

function heapPop() {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let p = 0;
    const n = heap.length;
    for (;;) {
      let l = p * 2 + 1, rr = l + 1, m = p;
      if (l < n && fScore[heap[l]] < fScore[heap[m]]) m = l;
      if (rr < n && fScore[heap[rr]] < fScore[heap[m]]) m = rr;
      if (m === p) break;
      const t = heap[p]; heap[p] = heap[m]; heap[m] = t;
      p = m;
    }
  }
  return top;
}

function octile(ax, az, bx, bz) {
  const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
  return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
}

// A* on the grid. Returns a smoothed list of world-space waypoints (excluding the
// start), or null when no route exists. Blocked start/goal snap to nearest walkable.
export function findPath(fromX, fromZ, toX, toZ) {
  if (N === 0) return null;
  let sx = ixOf(fromX), sz = izOf(fromZ);
  let tx = ixOf(toX), tz = izOf(toZ);
  if (!cellWalkable(sx, sz)) {
    const s = nearestWalkableCell(sx, sz);
    if (s < 0) return null;
    sx = s % W; sz = (s - sx) / W;
  }
  if (!cellWalkable(tx, tz)) {
    const t = nearestWalkableCell(tx, tz);
    if (t < 0) return null;
    tx = t % W; tz = (t - tx) / W;
  }
  const start = idx(sx, sz), goal = idx(tx, tz);
  if (start === goal) return [{ x: cx(tx), z: cz(tz) }];

  curGen++;
  heap.length = 0;
  gScore[start] = 0;
  fScore[start] = octile(sx, sz, tx, tz);
  seenGen[start] = curGen;
  cameFrom[start] = -1;
  heapPush(start);

  let found = false;
  while (heap.length > 0) {
    const cur = heapPop();
    if (closedGen[cur] === curGen) continue;
    closedGen[cur] = curGen;
    if (cur === goal) { found = true; break; }
    const ix = cur % W, iz = (cur - ix) / W;
    const g = gScore[cur];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = ix + dx, nz = iz + dz;
        if (!cellWalkable(nx, nz)) continue;
        if (dx !== 0 && dz !== 0) {
          if (!cellWalkable(ix + dx, iz) || !cellWalkable(ix, iz + dz)) continue;
        }
        const ni = idx(nx, nz);
        if (closedGen[ni] === curGen) continue;
        const step = (dx !== 0 && dz !== 0) ? SQRT2 : 1;
        const ng = g + step;
        if (seenGen[ni] !== curGen || ng < gScore[ni]) {
          seenGen[ni] = curGen;
          gScore[ni] = ng;
          fScore[ni] = ng + octile(nx, nz, tx, tz);
          cameFrom[ni] = cur;
          heapPush(ni);
        }
      }
    }
  }
  if (!found) return null;

  const cellsPath = [];
  let node = goal;
  while (node !== -1) { cellsPath.push(node); node = cameFrom[node]; }
  cellsPath.reverse();

  // String pulling: keep only points where line-of-sight breaks.
  const pulled = [0];
  let anchor = 0;
  for (let i = 2; i < cellsPath.length; i++) {
    const a = cellsPath[anchor], b = cellsPath[i];
    const ax = a % W, az = (a - ax) / W, bx = b % W, bz = (b - bx) / W;
    if (!cellLOS(ax, az, bx, bz)) { pulled.push(i - 1); anchor = i - 1; }
  }
  pulled.push(cellsPath.length - 1);

  const out = [];
  for (let k = 1; k < pulled.length; k++) {
    const c = cellsPath[pulled[k]];
    const px = c % W, pz = (c - px) / W;
    out.push({ x: cx(px), z: cz(pz) });
  }
  return out.length ? out : [{ x: cx(tx), z: cz(tz) }];
}

// Fallback when A* fails and stuck: farthest reachable point straight toward target.
export function progressToward(x, z, tx, tz) {
  const dx = tx - x, dz = tz - z;
  const d = Math.hypot(dx, dz);
  if (d < 0.001) return null;
  const ux = dx / d, uz = dz / d;
  let last = null;
  for (let t = cell; t <= d; t += cell) {
    const px = x + ux * t, pz = z + uz * t;
    if (isWalkable(px, pz) && hasLineOfWalk(x, z, px, pz)) last = { x: px, z: pz };
    else break;
  }
  return last;
}
