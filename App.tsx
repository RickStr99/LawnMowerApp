/**
 * Lawn Mower Path Planner
 * React Native App
 *
 * Install dependencies:
 *   npx create-expo-app LawnMowerApp --template blank-typescript
 *   cd LawnMowerApp
 *   npx expo install react-native-gesture-handler react-native-reanimated
 *   npm install @react-native-community/slider
 *
 * Then replace App.tsx with this file and run:
 *   npx expo start
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  PanResponder,
  GestureResponderEvent,
  Dimensions,
  SafeAreaView,
} from 'react-native';
import { Svg, Path as SvgPath, Circle as SvgCircle, Rect, Line } from 'react-native-svg';

// ─── Types ────────────────────────────────────────────────────────────────────

type MowDirection = 'vertical' | 'horizontal' | 'diag-nwse' | 'diag-nesw';
type DrawMode = 'add' | 'erase' | 'start' | 'driveway' | 'move';

type MoveState = {
  keys: string[];                    // "col,row" keys of all cells being moved
  type: 'obstacle' | 'driveway';
  originCell: { col: number; row: number }; // cell that was tapped
  currentOffset: { dc: number; dr: number };
};

// Used inside bfsTransit
type BfsNode = { col: number; row: number; cost: number };

// Used inside computePath
type MowRun = PathPoint[];

interface PathPoint {
  col: number;
  row: number;
  transit?: boolean; // true = navigating around obstacle, not mowing
}

interface Stats {
  strips: number;
  distanceFt: number;
  turns: number;
  estimatedMinutes: number;
}

interface DirectionStep {
  id: number;
  text: string;
  isAction: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_MAX_SIZE = SCREEN_WIDTH - 32;
const MOWING_SPEED_MPH = 2.5; // good walking pace behind a mower
const TURN_TIME_SECONDS = 8;  // time to stop, turn, and re-align at each strip end

const COLORS = {
  background: '#F9F9F7',
  surface: '#FFFFFF',
  border: 'rgba(0,0,0,0.12)',
  textPrimary: '#1A1A1A',
  textSecondary: '#666666',
  textTertiary: '#999999',
  green: '#1D9E75',
  greenDark: '#3B6D11',
  greenLight: 'rgba(99,153,34,0.13)',
  greenAlt: 'rgba(99,153,34,0.05)',
  red: '#E24B4A',
  gray: '#888780',
  stripEven: 'rgba(99,153,34,0.13)',
  stripOdd: 'rgba(99,153,34,0.04)',
  obstacle: '#888780',
  driveway: '#C8BFB0',
  primary: '#1A1A1A',
  primaryText: '#FFFFFF',
};

// ─── Utility: Path computation ────────────────────────────────────────────────

function getEffectiveObstacles(
  gridCols: number,
  gridRows: number,
  obstacles: Set<string>,
  driveways: Set<string>,
): Set<string> {
  // Border cells are always walls. The mowable interior is everything inside the border.
  // We flood-fill from the second ring (first interior layer) to find all open cells.
  // Any interior cell not reachable = enclosed by obstacle+border → keep-out.
  // This correctly handles obstacles that use the border as part of their enclosure ring.

  const isInterior = (c: number, r: number) =>
    c > 0 && c < gridCols - 1 && r > 0 && r < gridRows - 1;

  const isWall = (c: number, r: number) =>
    !isInterior(c, r) || obstacles.has(`${c},${r}`);

  const reachable = new Set<string>();
  const queue: Array<{ col: number; row: number }> = [];

  // Seed from all non-obstacle cells on the second ring (interior cells adjacent to the border)
  for (let c = 1; c < gridCols - 1; c++) {
    for (let r = 1; r < gridRows - 1; r++) {
      const onSecondRing = c === 1 || c === gridCols - 2 || r === 1 || r === gridRows - 2;
      if (onSecondRing && !isWall(c, r)) {
        const key = `${c},${r}`;
        if (!reachable.has(key)) { reachable.add(key); queue.push({ col: c, row: r }); }
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const { col, row } = queue[head++];
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nc = col + dc;
      const nr = row + dr;
      if (isWall(nc, nr)) continue;
      const key = `${nc},${nr}`;
      if (reachable.has(key)) continue;
      reachable.add(key);
      queue.push({ col: nc, row: nr });
    }
  }

  const effective = new Set<string>(obstacles);

  // Border cells always dark
  for (let c = 0; c < gridCols; c++) {
    effective.add(`${c},0`);
    effective.add(`${c},${gridRows - 1}`);
  }
  for (let r = 1; r < gridRows - 1; r++) {
    effective.add(`0,${r}`);
    effective.add(`${gridCols - 1},${r}`);
  }

  // Interior cells not reachable from the second ring = enclosed keep-out
  for (let c = 1; c < gridCols - 1; c++) {
    for (let r = 1; r < gridRows - 1; r++) {
      const key = `${c},${r}`;
      if (!reachable.has(key)) effective.add(key);
    }
  }

  return effective;
}

function getEffectiveDriveways(
  gridCols: number,
  gridRows: number,
  driveways: Set<string>,
  obstacles: Set<string>,
): Set<string> {
  // Use raw obstacles only (NOT effectiveObstacles which includes border cells).
  // Border cells are handled by the virtual-ring seeding — they are grass cells
  // that get reached from outside, so only truly enclosed cells are unreachable.
  // Walls = painted driveway cells OR painted obstacle cells.
  const isWall = (c: number, r: number) => {
    const key = `${c},${r}`;
    return driveways.has(key) || obstacles.has(key);
  };

  const reachable = new Set<string>();
  const queue: Array<{ col: number; row: number }> = [];

  const seed = (c: number, r: number) => {
    const key = `${c},${r}`;
    if (!reachable.has(key)) { reachable.add(key); queue.push({ col: c, row: r }); }
  };

  // Seed from virtual ring outside the grid — border cells are NOT walls here
  for (let c = -1; c <= gridCols; c++) { seed(c, -1); seed(c, gridRows); }
  for (let r = 0; r < gridRows; r++) { seed(-1, r); seed(gridCols, r); }

  let head = 0;
  while (head < queue.length) {
    const { col, row } = queue[head++];
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nc = col + dc;
      const nr = row + dr;
      const key = `${nc},${nr}`;
      if (reachable.has(key)) continue;
      if (nc < -1 || nc > gridCols || nr < -1 || nr > gridRows) continue;
      // Stop at wall cells within the grid
      if (nc >= 0 && nc < gridCols && nr >= 0 && nr < gridRows && isWall(nc, nr)) continue;
      reachable.add(key);
      queue.push({ col: nc, row: nr });
    }
  }

  // Start from painted driveways, excluding any that overlap obstacles
  const effective = new Set<string>();
  for (const key of driveways) {
    if (!obstacles.has(key)) effective.add(key);
  }
  for (let c = 0; c < gridCols; c++) {
    for (let r = 0; r < gridRows; r++) {
      const key = `${c},${r}`;
      // Enclosed interior cells that aren't obstacles become driveway interior
      if (!reachable.has(key) && !obstacles.has(key)) effective.add(key);
    }
  }
  return effective;
}

// BFS connected-component decomposition: finds all contiguous mowable regions.
// Flood-fills through non-obstacle interior cells (driveways are passable).
function findRegions(
  gridCols: number,
  gridRows: number,
  obstacles: Set<string>,
): Array<Set<string>> {
  const visited = new Set<string>();
  const regions: Array<Set<string>> = [];
  for (let c = 1; c < gridCols - 1; c++) {
    for (let r = 1; r < gridRows - 1; r++) {
      const key = `${c},${r}`;
      if (visited.has(key) || obstacles.has(key)) continue;
      const region = new Set<string>();
      const q: Array<{ col: number; row: number }> = [{ col: c, row: r }];
      visited.add(key);
      region.add(key);
      let head = 0;
      while (head < q.length) {
        const { col, row } = q[head++];
        for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nc = col + dc;
          const nr = row + dr;
          if (nc < 1 || nc >= gridCols - 1 || nr < 1 || nr >= gridRows - 1) continue;
          const nk = `${nc},${nr}`;
          if (visited.has(nk) || obstacles.has(nk)) continue;
          visited.add(nk);
          region.add(nk);
          q.push({ col: nc, row: nr });
        }
      }
      regions.push(region);
    }
  }
  return regions;
}

// Dijkstra transit: routes between strips preferring already-mowed cells
// (cost 1) over fresh grass (cost 10) to avoid trampling unmowed areas.
function bfsTransit(
  from: PathPoint,
  to: PathPoint,
  gridCols: number,
  gridRows: number,
  obstacles: Set<string>,
  mowed: Set<string>,
  driveways: Set<string>,
): PathPoint[] | null {
  if (from.col === to.col && from.row === to.row) return [];

  // Simple priority queue via sorted array (small grids, acceptable perf)
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const startKey = `${from.col},${from.row}`;
  dist.set(startKey, 0);

  // Min-heap using array + sort on insert (sufficient for grid sizes here)
  const heap: BfsNode[] = [{ col: from.col, row: from.row, cost: 0 }];
  const heapPush = (n: BfsNode) => {
    heap.push(n);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].cost <= heap[i].cost) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const heapPop = (): BfsNode => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < heap.length && heap[l].cost < heap[s].cost) s = l;
        if (r < heap.length && heap[r].cost < heap[s].cost) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]];
        i = s;
      }
    }
    return top;
  };

  let found = false;
  while (heap.length > 0) {
    const { col, row, cost } = heapPop();
    const key = `${col},${row}`;
    if (col === to.col && row === to.row) { found = true; break; }
    if ((dist.get(key) ?? Infinity) < cost) continue;
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nc >= gridCols || nr < 0 || nr >= gridRows) continue;
      const nkey = `${nc},${nr}`;
      if (obstacles.has(nkey)) continue;
      // Prefer mowed or driveway cells (no grass to damage) over fresh grass
      const stepCost = (mowed.has(nkey) || driveways.has(nkey)) ? 1 : 10;
      const newCost = cost + stepCost;
      if (newCost < (dist.get(nkey) ?? Infinity)) {
        dist.set(nkey, newCost);
        prev.set(nkey, key);
        heapPush({ col: nc, row: nr, cost: newCost });
      }
    }
  }

  if (!found) return null;

  const result: PathPoint[] = [];
  let key = `${to.col},${to.row}`;
  while (prev.has(key)) {
    const [c, r] = key.split(',').map(Number);
    result.unshift({ col: c, row: r, transit: true });
    key = prev.get(key)!;
  }
  return result;
}

function computePath(
  gridCols: number,
  gridRows: number,
  obstacles: Set<string>,
  effectiveDriveways: Set<string>,
  startCell: { col: number; row: number } | null,
  forcedDirection?: MowDirection | null,
): { path: PathPoint[]; dominantDirection: MowDirection } {
  const isDriveway = (c: number, r: number) => effectiveDriveways.has(`${c},${r}`);
  const sc = startCell ?? { col: 1, row: 1 };
  const startCol = Math.max(1, Math.min(gridCols - 2, sc.col));
  const startRow = Math.max(1, Math.min(gridRows - 2, sc.row));

  // 1. Find connected regions (flood-fill through non-obstacle interior, driveways included)
  const regions = findRegions(gridCols, gridRows, obstacles);
  if (regions.length === 0) return { path: [], dominantDirection: 'vertical' };

  // 2. For each region, pick the direction that needs the fewest *contiguous runs*.
  //    Fewer runs = fewer transit moves needed. This beats counting unique strips because
  //    a direction with 5 columns each with 3 gaps (15 runs) loses to 7 gapless columns (7 runs).
  const countRunsForDir = (cells: Set<string>, dir: MowDirection): number => {
    const stripMap = new Map<number, number[]>(); // strip-idx → sorted cross-indices
    for (const key of cells) {
      const [c, r] = key.split(',').map(Number);
      // idx = which strip; cross = position within strip (determines adjacency)
      // NW-SE diagonal (diag-nwse): cells share c - r = constant
      // NE-SW diagonal (diag-nesw): cells share c + r = constant
      const idx   = dir === 'vertical' ? c : dir === 'horizontal' ? r : dir === 'diag-nwse' ? c - r : c + r;
      const cross = dir === 'vertical' ? r : dir === 'horizontal' ? c : c; // col along diagonal
      const b = stripMap.get(idx) ?? [];
      b.push(cross);
      stripMap.set(idx, b);
    }
    let total = 0;
    for (const crosses of stripMap.values()) {
      crosses.sort((a, b) => a - b);
      total++; // each strip has at least one run
      for (let i = 1; i < crosses.length; i++) {
        if (crosses[i] > crosses[i - 1] + 1) total++; // gap → new run
      }
    }
    return total;
  };

  const getBestDir = (region: Set<string>): MowDirection => {
    // If user has locked a direction, use it for every region
    if (forcedDirection) return forcedDirection;
    const mowable = new Set<string>();
    for (const key of region) {
      const [c, r] = key.split(',').map(Number);
      if (!isDriveway(c, r)) mowable.add(key);
    }
    if (mowable.size === 0) return 'vertical';
    const dirs: MowDirection[] = ['vertical', 'horizontal', 'diag-nwse', 'diag-nesw'];
    return dirs.reduce((best, dir) =>
      countRunsForDir(mowable, dir) < countRunsForDir(mowable, best) ? dir : best
    );
  };

  const regionDirs = regions.map(getBestDir);

  // 3. Order regions by nearest-neighbour from current position
  const unvisited = new Set<number>(regions.map((_, i) => i));
  const regionOrder: number[] = [];
  let curCol = startCol;
  let curRow = startRow;

  // Find the region that contains startCell (or nearest to it)
  let firstRegion = -1;
  const startKey = `${startCol},${startRow}`;
  for (let i = 0; i < regions.length; i++) {
    if (regions[i].has(startKey)) { firstRegion = i; break; }
  }
  if (firstRegion < 0) {
    let minD = Infinity;
    for (let i = 0; i < regions.length; i++) {
      for (const key of regions[i]) {
        const [c, r] = key.split(',').map(Number);
        const d = Math.abs(c - curCol) + Math.abs(r - curRow);
        if (d < minD) { minD = d; firstRegion = i; }
      }
    }
  }

  while (unvisited.size > 0) {
    let next = (firstRegion >= 0 && unvisited.has(firstRegion)) ? firstRegion : -1;
    firstRegion = -1;
    if (next < 0) {
      let minD = Infinity;
      for (const i of unvisited) {
        for (const key of regions[i]) {
          const [c, r] = key.split(',').map(Number);
          const d = Math.abs(c - curCol) + Math.abs(r - curRow);
          if (d < minD) { minD = d; next = i; }
        }
      }
    }
    unvisited.delete(next);
    regionOrder.push(next);
    // Update curPos estimate to last cell of this region (refined after strips are built)
    const cells = [...regions[next]];
    const [lc, lr] = cells[cells.length - 1].split(',').map(Number);
    curCol = lc; curRow = lr;
  }

  // 4. Split a region into individual contiguous runs, then order by nearest-neighbour.
  //    A "run" is an uninterrupted sequence of cells within one strip (no obstacle gaps).
  //    Nearest-neighbour ordering means the mower finishes one band (e.g. rows 1-3) across
  //    all columns before looping back for the band on the other side of an obstacle —
  //    eliminating the long mid-strip transit that causes backtracking.

  const makeRegionRuns = (
    region: Set<string>,
    dir: MowDirection,
    entryCol: number,
    entryRow: number,
  ): MowRun[] => {
    interface CellEntry { col: number; row: number; cross: number }
    const stripMap = new Map<number, CellEntry[]>();
    for (const key of region) {
      const [c, r] = key.split(',').map(Number);
      // Skip driveway cells — no grass to mow there. bfsTransit will route through
      // them only if needed to reach grass on the other side.
      if (isDriveway(c, r)) continue;
      // NW-SE diagonal (diag-nwse): cells share c - r = constant
      // NE-SW diagonal (diag-nesw): cells share c + r = constant
      const idx   = dir === 'vertical' ? c : dir === 'horizontal' ? r : dir === 'diag-nwse' ? c - r : c + r;
      const cross = dir === 'vertical' ? r : dir === 'horizontal' ? c : c;
      const b = stripMap.get(idx) ?? [];
      b.push({ col: c, row: r, cross });
      stripMap.set(idx, b);
    }

    // Split each strip into runs at obstacle/driveway gaps
    interface RunEntry { cells: MowRun; first: PathPoint; last: PathPoint }
    const allRuns: RunEntry[] = [];
    for (const entries of stripMap.values()) {
      entries.sort((a, b) => a.cross - b.cross);
      let start = 0;
      for (let i = 1; i <= entries.length; i++) {
        if (i === entries.length || entries[i].cross > entries[i - 1].cross + 1) {
          const runCells: MowRun = entries.slice(start, i).map(({ col, row }) => ({
            col, row,
          }));
          allRuns.push({ cells: runCells, first: runCells[0], last: runCells[runCells.length - 1] });
          start = i;
        }
      }
    }
    if (allRuns.length === 0) return [];

    // Order runs by nearest-neighbour TSP approximation.
    // This naturally groups runs in the same band together, so the mower sweeps one
    // band across all columns before transitioning to the next band.
    const ordered: MowRun[] = [];
    const remaining = new Set<number>(allRuns.map((_, i) => i));
    let cx = entryCol, cy = entryRow;

    while (remaining.size > 0) {
      let pick = -1, pickDist = Infinity, pickReverse = false;
      for (const i of remaining) {
        const { first, last } = allRuns[i];
        const dF = Math.abs(first.col - cx) + Math.abs(first.row - cy);
        const dL = Math.abs(last.col  - cx) + Math.abs(last.row  - cy);
        const d = Math.min(dF, dL);
        if (d < pickDist) { pickDist = d; pick = i; pickReverse = dL < dF; }
      }
      remaining.delete(pick);
      const cells = pickReverse ? [...allRuns[pick].cells].reverse() : allRuns[pick].cells;
      ordered.push(cells);
      cx = cells[cells.length - 1].col;
      cy = cells[cells.length - 1].row;
    }
    return ordered;
  };

  // 5. Assemble path across all regions with Dijkstra transit between non-adjacent cells
  const mowed = new Set<string>();
  const connected: PathPoint[] = [];
  let curPos = { col: startCol, row: startRow };

  const appendCell = (p: PathPoint, dir: MowDirection) => {
    if (connected.length > 0) {
      const last = connected[connected.length - 1];
      const dc = Math.abs(p.col - last.col);
      const dr = Math.abs(p.row - last.row);
      const isDiag = dir === 'diag-nwse' || dir === 'diag-nesw';
      const adjacent = (dc === 1 && dr === 0) || (dc === 0 && dr === 1)
        || (isDiag && dc === 1 && dr === 1);
      if (!adjacent) {
        const transit = bfsTransit(last, p, gridCols, gridRows, obstacles, mowed, effectiveDriveways);
        if (transit) {
          for (const t of transit.slice(0, transit.length - 1)) connected.push(t);
        }
      }
    }
    connected.push(p);
    if (!p.transit) mowed.add(`${p.col},${p.row}`);
  };

  for (const ri of regionOrder) {
    const dir = regionDirs[ri];
    const runs = makeRegionRuns(regions[ri], dir, curPos.col, curPos.row);
    for (const run of runs) {
      for (const p of run) appendCell(p, dir);
    }
    if (connected.length > 0) {
      const last = connected[connected.length - 1];
      curPos = { col: last.col, row: last.row };
    }
  }

  // 6. Dominant direction = direction used by the region with the most mowable cells
  const dirCells = new Map<MowDirection, number>();
  for (let i = 0; i < regions.length; i++) {
    const dir = regionDirs[i];
    let count = 0;
    for (const key of regions[i]) {
      const [c, r] = key.split(',').map(Number);
      if (!isDriveway(c, r)) count++;
    }
    dirCells.set(dir, (dirCells.get(dir) ?? 0) + count);
  }
  let dominantDirection: MowDirection = 'vertical';
  let maxCells = 0;
  for (const [dir, count] of dirCells) {
    if (count > maxCells) { maxCells = count; dominantDirection = dir; }
  }

  return { path: connected, dominantDirection };
}

function computeStats(
  path: PathPoint[],
  stripWidthIn: number,
  direction: MowDirection,
  gridCols: number,
  gridRows: number,
  effectiveDriveways: Set<string>,
): Stats {
  const stripFt = stripWidthIn / 12;
  const strips = (direction === 'vertical') ? gridCols
    : (direction === 'horizontal') ? gridRows
    : gridCols + gridRows - 1;
  let turns = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const dx1 = path[i].col - path[i - 1].col;
    const dy1 = path[i].row - path[i - 1].row;
    const dx2 = path[i + 1].col - path[i].col;
    const dy2 = path[i + 1].row - path[i].row;
    if (dx1 !== dx2 || dy1 !== dy2) turns++;
  }
  // Only count cells that are actually mowed (exclude transit and driveway cells)
  const mowedCells = path.filter(p => !p.transit && !effectiveDriveways.has(`${p.col},${p.row}`)).length;
  const distanceFt = mowedCells * stripFt;
  const walkMinutes = (distanceFt / (MOWING_SPEED_MPH * 5280)) * 60;
  const turnMinutes = (turns * TURN_TIME_SECONDS) / 60;
  const estimatedMinutes = Math.round(walkMinutes + turnMinutes);
  return { strips, distanceFt, turns, estimatedMinutes };
}

function buildDirections(
  path: PathPoint[],
  stripWidthIn: number,
  direction: MowDirection,
): DirectionStep[] {
  const steps: DirectionStep[] = [];
  const sf = stripWidthIn / 12;
  let id = 0;
  if (path.length > 0) {
    steps.push({ id: id++, text: `Start at your marked position`, isAction: false });
  }

  let stripNum = 1;
  let segStart = 0;

  for (let i = 1; i < path.length; i++) {
    const { col: pc, row: pr } = path[i - 1];
    const { col: cc, row: cr } = path[i];
    const changed = direction === 'vertical' ? cc !== pc : cr !== pr;
    if (changed) {
      const len = (i - segStart) * sf;
      const md =
        direction === 'vertical'
          ? path[segStart].row < path[i - 1].row ? 'south' : 'north'
          : path[segStart].col < path[i - 1].col ? 'east' : 'west';
      steps.push({ id: id++, text: `Strip ${stripNum}: mow ${Math.round(len)} ft heading ${md}`, isAction: false });
      steps.push({ id: id++, text: `Turn → advance to strip ${stripNum + 1}`, isAction: true });
      stripNum++;
      segStart = i;
    }
  }

  if (path.length > 0) {
    const last = path[path.length - 1];
    const fl = (path.length - segStart) * sf;
    const fd =
      direction === 'vertical'
        ? path[segStart].row < last.row ? 'south' : 'north'
        : path[segStart].col < last.col ? 'east' : 'west';
    steps.push({ id: id++, text: `Strip ${stripNum}: mow ${Math.round(fl)} ft heading ${fd}`, isAction: false });
    steps.push({ id: id++, text: `Done! Finished at strip ${stripNum}`, isAction: false });
  }

  return steps;
}

// ─── Zoomable + Pannable Grid Wrapper ────────────────────────────────────────

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 20; // allow very high zoom for pixel-level obstacle drawing

const ZoomableGrid: React.FC<{
  zoom: number;
  setZoom: (z: number) => void;
  children: React.ReactNode;
}> = ({ zoom, setZoom, children }) => {
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // ScrollView refs so we can programmatically scroll to keep pinch centre fixed
  const hScrollRef = useRef<ScrollView>(null);
  const vScrollRef = useRef<ScrollView>(null);
  const scrollXRef = useRef(0);
  const scrollYRef = useRef(0);

  // Pinch state
  const pinchActiveRef   = useRef(false);
  const pinchDistRef     = useRef(0);
  const pinchStartZoom   = useRef(1);
  // Midpoint of the two fingers in PAGE coords at the moment the pinch started
  const pinchMidPageRef  = useRef({ x: 0, y: 0 });
  // Scroll offsets at pinch-start — used to compute the content-point under fingers
  const pinchScrollStart = useRef({ x: 0, y: 0 });

  const [isPinching, setIsPinching] = useState(false);

  const pinchResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: (e) => e.nativeEvent.touches.length === 2,
      onMoveShouldSetPanResponderCapture:  (e) => e.nativeEvent.touches.length === 2,

      onPanResponderGrant: (e) => {
        const t = e.nativeEvent.touches;
        if (t.length < 2) return;
        const dx = t[0].pageX - t[1].pageX;
        const dy = t[0].pageY - t[1].pageY;
        pinchDistRef.current   = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoom.current = zoomRef.current;
        pinchMidPageRef.current  = {
          x: (t[0].pageX + t[1].pageX) / 2,
          y: (t[0].pageY + t[1].pageY) / 2,
        };
        pinchScrollStart.current = { x: scrollXRef.current, y: scrollYRef.current };
        pinchActiveRef.current = true;
        setIsPinching(true);
      },

      onPanResponderMove: (e) => {
        const t = e.nativeEvent.touches;
        if (!pinchActiveRef.current || t.length < 2 || pinchDistRef.current === 0) return;

        const dx   = t[0].pageX - t[1].pageX;
        const dy   = t[0].pageY - t[1].pageY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / pinchDistRef.current;
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinchStartZoom.current * scale));

        // The content-point under the pinch midpoint must stay fixed.
        // contentX = (scrollX + midPageX_relative) / oldZoom
        // newScrollX = contentX * newZoom - midPageX_relative
        // (midPageX_relative = midPageX - scrollView's left edge, approximated as midPageX
        //  since the scrollview fills the width; fine for our use case)
        const mid = pinchMidPageRef.current;
        const oldZoom = pinchStartZoom.current;
        const startScroll = pinchScrollStart.current;

        const contentX = (startScroll.x + mid.x) / oldZoom;
        const contentY = (startScroll.y + mid.y) / oldZoom;
        const newScrollX = Math.max(0, contentX * newZoom - mid.x);
        const newScrollY = Math.max(0, contentY * newZoom - mid.y);

        setZoom(newZoom);
        // Scroll immediately so the pinch centre stays stationary
        hScrollRef.current?.scrollTo({ x: newScrollX, animated: false });
        vScrollRef.current?.scrollTo({ y: newScrollY, animated: false });
      },

      onPanResponderRelease:   () => { pinchActiveRef.current = false; setIsPinching(false); },
      onPanResponderTerminate: () => { pinchActiveRef.current = false; setIsPinching(false); },
    }),
  ).current;

  return (
    <View {...pinchResponder.panHandlers} style={{ flex: 1 }}>
      <ScrollView
        ref={hScrollRef}
        horizontal
        showsHorizontalScrollIndicator
        scrollEnabled={!isPinching}
        bounces={false}
        onScroll={(e) => { scrollXRef.current = e.nativeEvent.contentOffset.x; }}
        scrollEventThrottle={16}
      >
        <ScrollView
          ref={vScrollRef}
          showsVerticalScrollIndicator
          scrollEnabled={!isPinching}
          bounces={false}
          onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
        >
          {children}
        </ScrollView>
      </ScrollView>
    </View>
  );
};

// ─── Grid Canvas Component ────────────────────────────────────────────────────

interface GridCanvasProps {
  gridCols: number;
  gridRows: number;
  cellSize: number;
  obstacles: Set<string>;
  effectiveObstacles: Set<string>;
  driveways: Set<string>;          // raw painted cells — for immediate visual feedback
  effectiveDriveways: Set<string>; // painted + enclosed interior
  path: PathPoint[];
  animStep: number; // how many path cells to show; -1 = show all
  direction: MowDirection;
  drawMode: DrawMode;
  drawShape: 'free' | 'rect' | 'fill'; // freehand paint | drag rectangle | flood fill
  startCell: { col: number; row: number } | null;
  precisionMode: boolean; // tap-only: drag does not draw additional cells
  selectedGroup: { keys: string[]; type: 'obstacle' | 'driveway' } | null;
  onDrawStart: () => void;
  onCellToggle: (col: number, row: number) => void;
  onStartSet: (col: number, row: number) => void;
  onSelectGroup: (keys: string[], type: 'obstacle' | 'driveway') => void;
  onDeselectGroup: () => void;
  onMoveCommit: (keys: string[], type: 'obstacle' | 'driveway', dc: number, dr: number) => void;
}

const GridCanvas: React.FC<GridCanvasProps> = ({
  gridCols,
  gridRows,
  cellSize,
  obstacles,
  effectiveObstacles,
  driveways,
  effectiveDriveways,
  path: fullPath,
  animStep,
  direction,
  drawMode,
  drawShape,
  precisionMode,
  startCell,
  selectedGroup,
  onDrawStart,
  onCellToggle,
  onStartSet,
  onSelectGroup,
  onDeselectGroup,
  onMoveCommit,
}) => {
  const path = animStep < 0 ? fullPath : fullPath.slice(0, animStep);
  const mowerPos = path.length > 0 ? path[path.length - 1] : null;
  const width = gridCols * cellSize;
  const height = gridRows * cellSize;

  const getCellFromXY = (x: number, y: number) => {
    const col = Math.floor(x / cellSize);
    const row = Math.floor(y / cellSize);
    if (col < 0 || col >= gridCols || row < 0 || row >= gridRows) return null;
    return { col, row };
  };

  // Fill all cells between two grid positions using Bresenham's line algorithm
  const interpolateCells = (
    col1: number, row1: number,
    col2: number, row2: number,
  ): Array<{ col: number; row: number }> => {
    const cells: Array<{ col: number; row: number }> = [];
    const dx = Math.abs(col2 - col1);
    const dy = Math.abs(row2 - row1);
    const sx = col1 < col2 ? 1 : -1;
    const sy = row1 < row2 ? 1 : -1;
    let err = dx - dy;
    let x = col1;
    let y = row1;
    for (;;) {
      cells.push({ col: x, row: y });
      if (x === col2 && y === row2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return cells;
  };

  // Stable refs so the once-created PanResponder always reads the latest values
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;
  const drawShapeRef = useRef(drawShape);
  drawShapeRef.current = drawShape;
  const precisionModeRef = useRef(precisionMode);
  precisionModeRef.current = precisionMode;
  const cellSizeRef = useRef(cellSize);
  cellSizeRef.current = cellSize;
  const onDrawStartRef = useRef(onDrawStart);
  onDrawStartRef.current = onDrawStart;
  const onCellToggleRef = useRef(onCellToggle);
  onCellToggleRef.current = onCellToggle;
  const onStartSetRef = useRef(onStartSet);
  onStartSetRef.current = onStartSet;
  const onMoveCommitRef = useRef(onMoveCommit);
  onMoveCommitRef.current = onMoveCommit;
  const onSelectGroupRef = useRef(onSelectGroup);
  onSelectGroupRef.current = onSelectGroup;
  const onDeselectGroupRef = useRef(onDeselectGroup);
  onDeselectGroupRef.current = onDeselectGroup;
  const selectedGroupRef = useRef(selectedGroup);
  selectedGroupRef.current = selectedGroup;
  // Bundle live state so PanResponder closures always read current values
  const gridStateRef = useRef({ gridCols, gridRows, effectiveObstacles, obstacles, driveways });
  gridStateRef.current = { gridCols, gridRows, effectiveObstacles, obstacles, driveways };

  // Freehand drawing
  const lastCellRef  = useRef<{ col: number; row: number } | null>(null);
  const lastPixelRef = useRef<{ x: number; y: number }   | null>(null);

  // Rectangle drawing: start + live preview
  const rectStartRef   = useRef<{ col: number; row: number } | null>(null);
  const previewRectRef = useRef<{ sc: number; sr: number; ec: number; er: number } | null>(null);
  const [previewRect, setPreviewRect] = useState<{ sc: number; sr: number; ec: number; er: number } | null>(null);

  // Move mode: the group being dragged + live offset preview
  const moveStateRef  = useRef<MoveState | null>(null);
  const hasDraggedRef = useRef(false);
  const [movePreview, setMovePreview] = useState<MoveState | null>(null);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 1,
      onMoveShouldSetPanResponder:  (e) => e.nativeEvent.touches.length === 1,

      onPanResponderGrant: (e: GestureResponderEvent) => {
        onDrawStartRef.current();
        lastCellRef.current  = null;
        lastPixelRef.current = null;
        moveStateRef.current = null;
        hasDraggedRef.current = false;
        const { locationX, locationY } = e.nativeEvent;
        const cell = getCellFromXY(locationX, locationY);
        if (!cell) return;

        if (drawModeRef.current === 'start') {
          onStartSetRef.current(cell.col, cell.row);
          return;
        }

        // ── Move mode ──────────────────────────────────────────────────────────
        if (drawModeRef.current === 'move') {
          const { obstacles: obs, driveways: drv } = gridStateRef.current;
          const key = `${cell.col},${cell.row}`;
          let type: 'obstacle' | 'driveway' | null = null;
          let sourceSet: Set<string> | null = null;

          // First check if tap is on an already-selected cell — if so, use that group for drag
          const sel = selectedGroupRef.current;
          if (sel && sel.keys.includes(key)) {
            type = sel.type;
            sourceSet = type === 'obstacle' ? obs : drv;
          } else if (obs.has(key)) {
            type = 'obstacle'; sourceSet = obs;
          } else if (drv.has(key)) {
            type = 'driveway'; sourceSet = drv;
          }

          if (!type || !sourceSet) {
            // Tapped empty space → deselect
            onDeselectGroupRef.current();
            return;
          }

          // BFS flood-fill the connected group of same-type cells
          const groupKeys: string[] = [];
          const visited = new Set<string>([key]);
          const q = [cell];
          while (q.length > 0) {
            const cur = q.shift()!;
            groupKeys.push(`${cur.col},${cur.row}`);
            for (const [dc, dr] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              const nk = `${cur.col+dc},${cur.row+dr}`;
              if (!visited.has(nk) && sourceSet!.has(nk)) {
                visited.add(nk);
                q.push({ col: cur.col+dc, row: cur.row+dr });
              }
            }
          }

          // Select the group — drag will follow if finger moves
          onSelectGroupRef.current(groupKeys, type);
          const ms: MoveState = {
            keys: groupKeys, type, originCell: cell, currentOffset: { dc: 0, dr: 0 },
          };
          moveStateRef.current = ms;
          // Don't show preview yet — only show when actually dragging
          return;
        }

        const shape = drawShapeRef.current;

        // ── Flood fill ─────────────────────────────────────────────────────────
        if (shape === 'fill') {
          const { gridCols: gc, gridRows: gr, effectiveObstacles: eo } = gridStateRef.current;
          if (eo.has(`${cell.col},${cell.row}`)) return;
          const visited = new Set<string>([`${cell.col},${cell.row}`]);
          const q: Array<{ col: number; row: number }> = [cell];
          while (q.length > 0) {
            const cur = q.shift()!;
            onCellToggleRef.current(cur.col, cur.row);
            for (const [dc, dr] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              const nc = cur.col+dc, nr = cur.row+dr;
              if (nc < 0 || nc >= gc || nr < 0 || nr >= gr) continue;
              const nk = `${nc},${nr}`;
              if (!visited.has(nk) && !eo.has(nk)) { visited.add(nk); q.push({ col: nc, row: nr }); }
            }
          }
          return;
        }

        // ── Rectangle ──────────────────────────────────────────────────────────
        if (shape === 'rect') {
          rectStartRef.current = cell;
          const r = { sc: cell.col, sr: cell.row, ec: cell.col, er: cell.row };
          previewRectRef.current = r;
          setPreviewRect(r);
          return;
        }

        // ── Freehand ───────────────────────────────────────────────────────────
        lastCellRef.current  = cell;
        lastPixelRef.current = { x: locationX, y: locationY };
        onCellToggleRef.current(cell.col, cell.row);
      },

      onPanResponderMove: (e: GestureResponderEvent) => {
        if (drawModeRef.current === 'start') return;
        const { locationX, locationY } = e.nativeEvent;
        const cell = getCellFromXY(locationX, locationY);
        if (!cell) return;

        // ── Move drag ──────────────────────────────────────────────────────────
        if (drawModeRef.current === 'move') {
          const ms = moveStateRef.current;
          if (!ms) return;
          const dc = cell.col - ms.originCell.col;
          const dr = cell.row - ms.originCell.row;
          if (dc !== 0 || dr !== 0) hasDraggedRef.current = true;
          if (dc !== ms.currentOffset.dc || dr !== ms.currentOffset.dr) {
            ms.currentOffset = { dc, dr };
            setMovePreview({ ...ms, currentOffset: { dc, dr } });
          }
          return;
        }

        const shape = drawShapeRef.current;

        if (shape === 'rect') {
          const start = rectStartRef.current;
          if (!start) return;
          const r = {
            sc: Math.min(start.col, cell.col), sr: Math.min(start.row, cell.row),
            ec: Math.max(start.col, cell.col), er: Math.max(start.row, cell.row),
          };
          previewRectRef.current = r;
          setPreviewRect({ ...r });
          return;
        }

        if (shape === 'fill') return;

        if (precisionModeRef.current) return;

        const last   = lastCellRef.current;
        const lastPx = lastPixelRef.current;
        if (!last || !lastPx) {
          lastCellRef.current  = cell;
          lastPixelRef.current = { x: locationX, y: locationY };
          onCellToggleRef.current(cell.col, cell.row);
          return;
        }
        if (cell.col === last.col && cell.row === last.row) return;
        const dx = locationX - lastPx.x, dy = locationY - lastPx.y;
        if (Math.sqrt(dx*dx + dy*dy) < cellSizeRef.current * 0.4) return;
        const cells = interpolateCells(last.col, last.row, cell.col, cell.row);
        for (const c of cells) onCellToggleRef.current(c.col, c.row);
        lastCellRef.current  = cell;
        lastPixelRef.current = { x: locationX, y: locationY };
      },

      onPanResponderRelease: () => {
        // Commit move only if the finger actually dragged; tap just selects
        if (drawModeRef.current === 'move' && moveStateRef.current) {
          if (hasDraggedRef.current) {
            const { keys, type, currentOffset: { dc, dr } } = moveStateRef.current;
            onMoveCommitRef.current(keys, type, dc, dr);
          }
          moveStateRef.current = null;
          hasDraggedRef.current = false;
          setMovePreview(null);
          return;
        }
        // Commit rect
        if (drawShapeRef.current === 'rect' && previewRectRef.current) {
          const { sc, sr, ec, er } = previewRectRef.current;
          for (let c = sc; c <= ec; c++)
            for (let r = sr; r <= er; r++)
              onCellToggleRef.current(c, r);
          rectStartRef.current   = null;
          previewRectRef.current = null;
          setPreviewRect(null);
        }
        lastCellRef.current  = null;
        lastPixelRef.current = null;
      },
    }),
  ).current;

  const buildPathStrings = (): { mow: string; transit: string } => {
    const cx = (p: PathPoint) => p.col * cellSize + cellSize / 2;
    const cy = (p: PathPoint) => p.row * cellSize + cellSize / 2;
    let mow = '';
    let transit = '';

    for (let i = 0; i < path.length; i++) {
      const curr = path[i];
      const x = cx(curr);
      const y = cy(curr);

      if (i === 0) {
        if (curr.transit) transit += `M ${x} ${y}`;
        else mow += `M ${x} ${y}`;
        continue;
      }

      const prev = path[i - 1];
      const dc = Math.abs(curr.col - prev.col);
      const dr = Math.abs(curr.row - prev.row);
      // Include diagonal adjacency: per-region paths may have diagonal strips
      const adjacent = (dc === 1 && dr === 0) || (dc === 0 && dr === 1) || (dc === 1 && dr === 1);

      if (curr.transit) {
        // Transit segment: draw on transit path, lift mow pen
        transit += adjacent ? ` L ${x} ${y}` : ` M ${x} ${y}`;
        mow += ` M ${x} ${y}`; // keep mow pen at current position for next mow cell
      } else {
        // Mow segment: draw on mow path, lift transit pen
        if (prev.transit) {
          // Arriving from transit — continue mow from current position
          mow += ` M ${x} ${y}`;
        } else {
          mow += adjacent ? ` L ${x} ${y}` : ` M ${x} ${y}`;
        }
        transit += ` M ${x} ${y}`;
      }
    }

    return { mow, transit };
  };

  const { mow: mowPathString, transit: transitPathString } = path.length > 1
    ? buildPathStrings()
    : { mow: '', transit: '' };
  const startPoint = path.length > 0 ? path[0] : null;
  const endPoint = path.length > 0 ? path[path.length - 1] : null;
  const dotR = Math.max(4, cellSize * 0.45);
  const strokeWidth = Math.max(1.5, cellSize * 0.35);

  return (
    <View
      style={[styles.gridWrapper, { width, height }]}
      {...panResponder.panHandlers}
    >
      <Svg width={width} height={height}>
        {/* Draw cells */}
        {Array.from({ length: gridRows }, (_, r) =>
          Array.from({ length: gridCols }, (_, c) => {
            const isObstacle = effectiveObstacles.has(`${c},${r}`);
            const isDriveway = !isObstacle && (driveways.has(`${c},${r}`) || effectiveDriveways.has(`${c},${r}`));
            const si = direction === 'vertical' ? c : r;
            const fill = isObstacle
              ? COLORS.obstacle
              : isDriveway
              ? COLORS.driveway
              : si % 2 === 0
              ? COLORS.stripEven
              : COLORS.stripOdd;
            return (
              <Rect
                key={`${c},${r}`}
                x={c * cellSize}
                y={r * cellSize}
                width={cellSize}
                height={cellSize}
                fill={fill}
              />
            );
          }),
        )}

        {/* Grid lines */}
        {cellSize >= 8 &&
          Array.from({ length: gridRows + 1 }, (_, r) => (
            <Line
              key={`hr${r}`}
              x1={0} y1={r * cellSize}
              x2={width} y2={r * cellSize}
              stroke="rgba(128,128,128,0.15)"
              strokeWidth={0.5}
            />
          ))}
        {cellSize >= 8 &&
          Array.from({ length: gridCols + 1 }, (_, c) => (
            <Line
              key={`vc${c}`}
              x1={c * cellSize} y1={0}
              x2={c * cellSize} y2={height}
              stroke="rgba(128,128,128,0.15)"
              strokeWidth={0.5}
            />
          ))}

        {/* Transit path (around obstacles) */}
        {transitPathString ? (
          <SvgPath
            d={transitPathString}
            stroke="#F59E0B"
            strokeWidth={Math.max(1, strokeWidth * 0.6)}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={`${cellSize * 0.4} ${cellSize * 0.3}`}
            fill="none"
          />
        ) : null}

        {/* Mowing path */}
        {mowPathString ? (
          <SvgPath
            d={mowPathString}
            stroke={COLORS.green}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
          />
        ) : null}

        {/* Selected group highlight (move mode, before dragging) */}
        {!movePreview && selectedGroup && selectedGroup.keys.map(key => {
          const [c, r] = key.split(',').map(Number);
          return (
            <Rect key={`sel-${key}`}
              x={c * cellSize} y={r * cellSize}
              width={cellSize} height={cellSize}
              fill="none"
              stroke="#7C3AED"
              strokeWidth={Math.max(1.5, cellSize * 0.15)}
            />
          );
        })}

        {/* Move mode: ghost of original position + preview at destination */}
        {movePreview && movePreview.keys.map(key => {
          const [oc, or2] = key.split(',').map(Number);
          const dc = movePreview.currentOffset.dc;
          const dr = movePreview.currentOffset.dr;
          return (
            <React.Fragment key={key}>
              {/* dim original */}
              <Rect x={oc*cellSize} y={or2*cellSize} width={cellSize} height={cellSize}
                fill="rgba(0,0,0,0.35)" />
              {/* preview at destination */}
              <Rect
                x={(oc+dc)*cellSize} y={(or2+dr)*cellSize}
                width={cellSize} height={cellSize}
                fill={movePreview.type === 'obstacle' ? 'rgba(136,135,128,0.75)' : 'rgba(200,191,176,0.75)'}
                stroke={movePreview.type === 'obstacle' ? '#555350' : '#78716C'}
                strokeWidth={1.5}
              />
            </React.Fragment>
          );
        })}

        {/* Rectangle draw preview */}
        {previewRect && (
          <Rect
            x={previewRect.sc * cellSize}
            y={previewRect.sr * cellSize}
            width={(previewRect.ec - previewRect.sc + 1) * cellSize}
            height={(previewRect.er - previewRect.sr + 1) * cellSize}
            fill={drawMode === 'erase'
              ? 'rgba(239,68,68,0.20)'
              : drawMode === 'driveway'
              ? 'rgba(200,191,176,0.55)'
              : 'rgba(136,135,128,0.50)'}
            stroke={drawMode === 'erase' ? '#EF4444' : drawMode === 'driveway' ? '#78716C' : '#555350'}
            strokeWidth={2}
            strokeDasharray={`${cellSize * 0.6} ${cellSize * 0.3}`}
          />
        )}

        {/* Start cell marker (user's chosen position) */}
        {startCell && (
          <SvgCircle
            cx={startCell.col * cellSize + cellSize / 2}
            cy={startCell.row * cellSize + cellSize / 2}
            r={dotR + 2}
            fill="none"
            stroke="#F59E0B"
            strokeWidth={2}
          />
        )}

        {/* Start dot (actual path start) */}
        {startPoint && (
          <SvgCircle
            cx={startPoint.col * cellSize + cellSize / 2}
            cy={startPoint.row * cellSize + cellSize / 2}
            r={dotR}
            fill={COLORS.greenDark}
          />
        )}

        {/* End dot */}
        {endPoint && animStep < 0 && (
          <SvgCircle
            cx={endPoint.col * cellSize + cellSize / 2}
            cy={endPoint.row * cellSize + cellSize / 2}
            r={dotR}
            fill={COLORS.red}
          />
        )}

        {/* Mower position during animation */}
        {animStep >= 0 && mowerPos && (
          <>
            <SvgCircle
              cx={mowerPos.col * cellSize + cellSize / 2}
              cy={mowerPos.row * cellSize + cellSize / 2}
              r={dotR + 3}
              fill="#FFFFFF"
              opacity={0.85}
            />
            <SvgCircle
              cx={mowerPos.col * cellSize + cellSize / 2}
              cy={mowerPos.row * cellSize + cellSize / 2}
              r={dotR + 1}
              fill={mowerPos.transit ? '#F59E0B' : COLORS.greenDark}
            />
          </>
        )}
      </Svg>
    </View>
  );
};

// ─── Subcomponents ────────────────────────────────────────────────────────────

const StatCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.statCard}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={styles.statValue}>{value}</Text>
  </View>
);

const SectionHeader: React.FC<{ title: string }> = ({ title }) => (
  <Text style={styles.sectionHeader}>{title}</Text>
);


// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [areaLength, setAreaLength] = useState('100');
  const [areaWidth, setAreaWidth] = useState('100');
  const [stripWidth, setStripWidth] = useState('21');
  const [startCell, setStartCell] = useState<{ col: number; row: number } | null>(null);
  const [direction, setDirection] = useState<MowDirection>('vertical');
  const [drawMode, setDrawMode] = useState<DrawMode>('add');
  const [precisionMode, setPrecisionMode] = useState(false);
  const [drawShape, setDrawShape] = useState<'free' | 'rect' | 'fill'>('free');
  const [history, setHistory] = useState<Array<{
    obstacles: Set<string>;
    driveways: Set<string>;
    startCell: { col: number; row: number } | null;
  }>>([]);
  const [obstacles, setObstacles] = useState<Set<string>>(new Set());
  const [driveways, setDriveways] = useState<Set<string>>(new Set());
  const [path, setPath] = useState<PathPoint[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [directions, setDirections] = useState<DirectionStep[]>([]);
  const [activeTab, setActiveTab] = useState<'visual' | 'directions'>('visual');
  const [hasCalculated, setHasCalculated] = useState(false);
  const [bestDirection, setBestDirection] = useState<MowDirection | null>(null);
  // null = auto-pick per region; non-null = force this direction for all regions
  const [forcedDirection, setForcedDirection] = useState<MowDirection | null>(null);
  const [zoom, setZoom] = useState(1);
  const [animStep, setAnimStep] = useState(-1);   // -1 = show full path
  const [animating, setAnimating] = useState(false);
  const [animDone, setAnimDone] = useState(false); // true after animation finishes
  // Move mode: currently selected connected group
  const [selectedGroup, setSelectedGroup] = useState<{
    keys: string[];
    type: 'obstacle' | 'driveway';
  } | null>(null);
  const animIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAnim = () => {
    if (animIntervalRef.current !== null) {
      clearInterval(animIntervalRef.current);
      animIntervalRef.current = null;
    }
    setAnimating(false);
    setAnimDone(false);
  };

  const startAnim = (fromStep = 0) => {
    stopAnim();
    if (path.length === 0) return;
    const msPerStep = Math.max(16, 5000 / path.length);
    setAnimStep(fromStep);
    setAnimating(true);
    let step = fromStep;
    animIntervalRef.current = setInterval(() => {
      step += 1;
      setAnimStep(step);
      if (step >= path.length) {
        clearInterval(animIntervalRef.current!);
        animIntervalRef.current = null;
        setAnimating(false);
        setAnimStep(-1);  // show full path when done
        setAnimDone(true);
      }
    }, msPerStep);
  };

  // Clean up on unmount
  useEffect(() => () => stopAnim(), []);

  const aL = parseFloat(areaLength) || 100;
  const aW = parseFloat(areaWidth) || 100;
  const sW = parseFloat(stripWidth) || 21;
  const stripFt = sW / 12;

  // Use a fixed grid size regardless of direction so all 4 trials are comparable
  const gridCols = Math.max(3, Math.round(aL / stripFt));
  const gridRows = Math.max(3, Math.round(aW / stripFt));

  const maxDim = Math.max(gridCols, gridRows);
  const baseCellSize = Math.max(4, Math.min(20, Math.floor(GRID_MAX_SIZE / maxDim)));
  const cellSize = Math.max(4, Math.round(baseCellSize * zoom));

  const effectiveObstacles = getEffectiveObstacles(gridCols, gridRows, obstacles, driveways);
  const effectiveDriveways = getEffectiveDriveways(gridCols, gridRows, driveways, obstacles);

  const handleCellToggle = useCallback(
    (col: number, row: number) => {
      const key = `${col},${row}`;
      if (drawMode === 'add') {
        setObstacles(prev => { const n = new Set(prev); n.add(key); return n; });
        setDriveways(prev => { const n = new Set(prev); n.delete(key); return n; });
      } else if (drawMode === 'driveway') {
        // Never overwrite an obstacle cell with driveway
        setObstacles(prev => {
          if (prev.has(key)) return prev;
          return prev;
        });
        setDriveways(prev => {
          // Only paint driveway if the cell is not an obstacle
          if (obstacles.has(key)) return prev;
          const n = new Set(prev); n.add(key); return n;
        });
      } else if (drawMode === 'erase') {
        setObstacles(prev => { const n = new Set(prev); n.delete(key); return n; });
        setDriveways(prev => { const n = new Set(prev); n.delete(key); return n; });
      }
    },
    [drawMode],
  );

  const handleStartSet = useCallback((col: number, row: number) => {
    setStartCell({ col, row });
    setDrawMode('add'); // switch back to obstacle mode after placing start
  }, []);

  // Called once at the start of every draw gesture — snapshots state for undo.
  // Using a ref for obstacles/driveways/startCell so the callback is always fresh.
  const handleSelectGroup = useCallback((keys: string[], type: 'obstacle' | 'driveway') => {
    setSelectedGroup({ keys, type });
  }, []);

  const handleDeselectGroup = useCallback(() => {
    setSelectedGroup(null);
  }, []);

  const handleDrawStart = useCallback(() => {
    setHistory(prev => {
      const next = [...prev, {
        obstacles: new Set(obstacles),
        driveways: new Set(driveways),
        startCell,
      }];
      // Cap stack at 50 to avoid unbounded memory use
      return next.length > 50 ? next.slice(next.length - 50) : next;
    });
  }, [obstacles, driveways, startCell]);

  const handleUndo = useCallback(() => {
    setHistory(prev => {
      if (prev.length === 0) return prev;
      const snap = prev[prev.length - 1];
      setObstacles(snap.obstacles);
      setDriveways(snap.driveways);
      setStartCell(snap.startCell);
      return prev.slice(0, -1);
    });
  }, []);

  // Drag-move commit: remove cells from original positions, add at offset destination.
  // Also updates the selectedGroup keys to the new positions.
  const handleMoveCommit = useCallback((
    keys: string[], type: 'obstacle' | 'driveway', dc: number, dr: number,
  ) => {
    if (dc === 0 && dr === 0) return;
    // Compute newKeys synchronously BEFORE any setState calls
    const newKeys: string[] = [];
    for (const k of keys) {
      const [c, r] = k.split(',').map(Number);
      const nc = c + dc, nr = r + dr;
      if (nc >= 1 && nc <= gridCols - 2 && nr >= 1 && nr <= gridRows - 2) {
        newKeys.push(`${nc},${nr}`);
      }
    }
    const applyShift = (prev: Set<string>) => {
      const n = new Set(prev);
      keys.forEach(k => n.delete(k));
      newKeys.forEach(k => n.add(k));
      return n;
    };
    if (type === 'obstacle') setObstacles(applyShift);
    else setDriveways(applyShift);
    // Keep selection on the moved group so nudge arrows work immediately after drag
    setSelectedGroup({ keys: newKeys, type });
  }, [gridCols, gridRows]);

  // Nudge only the currently selected group one cell in a direction
  const handleNudge = useCallback((dc: number, dr: number) => {
    if (!selectedGroup) return;
    const { keys, type } = selectedGroup;
    // Compute newKeys synchronously BEFORE any setState calls
    const newKeys: string[] = [];
    for (const k of keys) {
      const [c, r] = k.split(',').map(Number);
      const nc = c + dc, nr = r + dr;
      if (nc >= 1 && nc <= gridCols - 2 && nr >= 1 && nr <= gridRows - 2) {
        newKeys.push(`${nc},${nr}`);
      }
    }
    setHistory(prev => [...prev, { obstacles: new Set(obstacles), driveways: new Set(driveways), startCell }]);
    const applyShift = (prev: Set<string>) => {
      const n = new Set(prev);
      keys.forEach(k => n.delete(k));
      newKeys.forEach(k => n.add(k));
      return n;
    };
    if (type === 'obstacle') setObstacles(applyShift);
    else setDriveways(applyShift);
    setSelectedGroup({ keys: newKeys, type });
  }, [gridCols, gridRows, selectedGroup, obstacles, driveways, startCell]);

  const handleCalculate = () => {
    stopAnim();
    setAnimStep(-1);

    // Candidate starting points: 4 interior corners + edge midpoints + centre + user-chosen start.
    // Per-region direction is auto-selected; we only search over start positions.
    const cx = Math.floor(gridCols / 2);
    const cy = Math.floor(gridRows / 2);
    const candidates: Array<{ col: number; row: number }> = [
      { col: 1,            row: 1 },
      { col: gridCols - 2, row: 1 },
      { col: 1,            row: gridRows - 2 },
      { col: gridCols - 2, row: gridRows - 2 },
      { col: cx,           row: cy },
      { col: cx,           row: 1 },
      { col: cx,           row: gridRows - 2 },
      { col: 1,            row: cy },
      { col: gridCols - 2, row: cy },
    ];
    if (startCell) candidates.unshift(startCell);

    let bestPath: PathPoint[] = [];
    let bestStats: Stats | null = null;
    let bestDir: MowDirection = 'vertical';
    let bestStart: { col: number; row: number } = candidates[0];
    let bestTime = Infinity;

    for (const sc of candidates) {
      if (effectiveObstacles.has(`${sc.col},${sc.row}`)) continue;
      const { path: p, dominantDirection: dir } = computePath(
        gridCols, gridRows, effectiveObstacles, effectiveDriveways, sc, forcedDirection,
      );
      const s = computeStats(p, sW, dir, gridCols, gridRows, effectiveDriveways);
      if (s.estimatedMinutes < bestTime) {
        bestTime = s.estimatedMinutes;
        bestPath = p;
        bestStats = s;
        bestDir = dir;
        bestStart = sc;
      }
    }

    const newDirections = buildDirections(bestPath, sW, bestDir);
    setPath(bestPath);
    setStats(bestStats);
    setDirections(newDirections);
    setDirection(bestDir);
    setBestDirection(bestDir);
    setStartCell(bestStart);
    setHasCalculated(true);
    setAnimDone(false);
  };

  const handleClearObstacles = () => {
    setObstacles(new Set());
    setDriveways(new Set());
    if (hasCalculated) {
      const { path: newPath, dominantDirection: newDir } = computePath(
        gridCols, gridRows, new Set(), new Set(), startCell, forcedDirection,
      );
      setPath(newPath);
      setStats(computeStats(newPath, sW, newDir, gridCols, gridRows, new Set<string>()));
      setDirections(buildDirections(newPath, sW, newDir));
      setDirection(newDir);
    }
  };

  const handleReset = () => {
    stopAnim();
    setAnimStep(-1);
    setObstacles(new Set());
    setDriveways(new Set());
    setStartCell(null);
    setPath([]);
    setStats(null);
    setDirections([]);
    setHasCalculated(false);
    setBestDirection(null);
    setAnimDone(false);
    setForcedDirection(null);
    setHistory([]);
  };

  // Clear only the calculated path so a new start position / recalculation can be tried.
  // Keeps obstacles, driveways, and grid settings intact.
  const clearPath = () => {
    stopAnim();
    setAnimStep(-1);
    setAnimDone(false);
    setPath([]);
    setStats(null);
    setDirections([]);
    setHasCalculated(false);
    setBestDirection(null);
  };

  const formatTime = (mins: number) =>
    mins < 60 ? `~${mins} min` : `~${(mins / 60).toFixed(1)} hr`;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <Text style={styles.title}>Lawn mower path planner</Text>

        {/* Area inputs */}
        <SectionHeader title="Area dimensions" />
        <View style={styles.row}>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Length (ft)</Text>
            <TextInput
              style={styles.input}
              value={areaLength}
              onChangeText={setAreaLength}
              keyboardType="numeric"
              returnKeyType="done"
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Width (ft)</Text>
            <TextInput
              style={styles.input}
              value={areaWidth}
              onChangeText={setAreaWidth}
              keyboardType="numeric"
              returnKeyType="done"
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Strip (in)</Text>
            <TextInput
              style={styles.input}
              value={stripWidth}
              onChangeText={setStripWidth}
              keyboardType="numeric"
              returnKeyType="done"
            />
          </View>
        </View>

        {/* Mow direction — manual lock or auto per region */}
        <SectionHeader title="Mow direction" />
        <Text style={styles.hint}>
          {forcedDirection
            ? `Locked: all regions will mow ${forcedDirection === 'vertical' ? 'N–S' : forcedDirection === 'horizontal' ? 'E–W' : forcedDirection === 'diag-nwse' ? '↘ diagonal' : '↗ diagonal'}. Tap again or Auto to unlock.`
            : bestDirection
              ? `Auto-selected: ${bestDirection === 'vertical' ? 'N–S' : bestDirection === 'horizontal' ? 'E–W' : bestDirection === 'diag-nwse' ? '↘ diagonal' : '↗ diagonal'} dominant — tap a direction to lock it for next calculate.`
              : 'Auto-picks best direction per region. Tap to lock all regions to one direction.'}
        </Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.toggleBtn, !forcedDirection && styles.toggleBtnActive]}
            onPress={() => setForcedDirection(null)}
          >
            <Text style={[styles.toggleText, !forcedDirection && styles.toggleTextActive]}>Auto</Text>
          </TouchableOpacity>
          {(['vertical', 'horizontal', 'diag-nwse', 'diag-nesw'] as MowDirection[]).map(dir => {
            const label = dir === 'vertical' ? 'N–S' : dir === 'horizontal' ? 'E–W' : dir === 'diag-nwse' ? '↘ Diag' : '↗ Diag';
            const isLocked = forcedDirection === dir;
            const isBest = !forcedDirection && bestDirection === dir;
            return (
              <TouchableOpacity
                key={dir}
                style={[styles.toggleBtn, isLocked && styles.toggleBtnActive, isBest && styles.toggleBtnBest]}
                onPress={() => setForcedDirection(isLocked ? null : dir)}
              >
                <Text style={[styles.toggleText, isLocked && styles.toggleTextActive]}>
                  {isBest ? `★ ${label}` : label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Grid mode selector */}
        <SectionHeader title="Grid drawing mode" />
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.toggleBtn, drawMode === 'start' && styles.toggleBtnStart]}
            onPress={() => setDrawMode('start')}
          >
            <Text style={[styles.toggleText, drawMode === 'start' && styles.toggleTextActive]}>
              {startCell ? '★ Start set' : '☆ Set start'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, drawMode === 'add' && styles.toggleBtnDanger]}
            onPress={() => setDrawMode('add')}
          >
            <Text style={[styles.toggleText, drawMode === 'add' && styles.toggleTextActive]}>
              Obstacle
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, drawMode === 'driveway' && styles.toggleBtnDriveway]}
            onPress={() => setDrawMode('driveway')}
          >
            <Text style={[styles.toggleText, drawMode === 'driveway' && styles.toggleTextActive]}>
              Driveway
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, drawMode === 'erase' && styles.toggleBtnInfo]}
            onPress={() => { setDrawMode('erase'); setSelectedGroup(null); }}
          >
            <Text style={[styles.toggleText, drawMode === 'erase' && styles.toggleTextActive]}>
              Erase
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, drawMode === 'move' && styles.toggleBtnMove]}
            onPress={() => { setDrawMode('move'); setSelectedGroup(null); }}
          >
            <Text style={[styles.toggleText, drawMode === 'move' && styles.toggleTextActive]}>
              ✥ Move
            </Text>
          </TouchableOpacity>
        </View>

        {/* Nudge arrows — only shown in move mode */}
        {drawMode === 'move' && (
          <View style={styles.nudgeContainer}>
            <Text style={styles.nudgeLabel}>
              {selectedGroup
                ? `Nudge selected (${selectedGroup.keys.length} cells)`
                : 'Tap an object to select it'}
            </Text>
            <View style={[styles.nudgeCross, !selectedGroup && { opacity: 0.35 }]}>
              <TouchableOpacity style={styles.nudgeBtn} disabled={!selectedGroup} onPress={() => handleNudge(0, -1)}>
                <Text style={styles.nudgeBtnText}>▲</Text>
              </TouchableOpacity>
              <View style={styles.nudgeMiddleRow}>
                <TouchableOpacity style={styles.nudgeBtn} disabled={!selectedGroup} onPress={() => handleNudge(-1, 0)}>
                  <Text style={styles.nudgeBtnText}>◀</Text>
                </TouchableOpacity>
                <View style={[styles.nudgeBtn, { backgroundColor: 'transparent', borderColor: 'transparent' }]} />
                <TouchableOpacity style={styles.nudgeBtn} disabled={!selectedGroup} onPress={() => handleNudge(1, 0)}>
                  <Text style={styles.nudgeBtnText}>▶</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={styles.nudgeBtn} disabled={!selectedGroup} onPress={() => handleNudge(0, 1)}>
                <Text style={styles.nudgeBtnText}>▼</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Shape selector + precision toggle */}
        <View style={styles.row}>
          {([['free', '✏ Freehand'], ['rect', '▭ Rectangle'], ['fill', '◉ Fill']] as const).map(([shape, label]) => (
            <TouchableOpacity
              key={shape}
              style={[styles.toggleBtn, drawShape === shape && styles.toggleBtnActive]}
              onPress={() => { setDrawShape(shape); if (shape !== 'free') setPrecisionMode(false); }}
            >
              <Text style={[styles.toggleText, drawShape === shape && styles.toggleTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
          {drawShape === 'free' && (
            <TouchableOpacity
              style={[styles.toggleBtn, precisionMode && styles.precisionBtnActive]}
              onPress={() => setPrecisionMode(p => !p)}
            >
              <Text style={[styles.toggleText, precisionMode && styles.toggleTextActive]}>
                {precisionMode ? '⊙ Tap only' : '⊙ Tap only'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
        <Text style={styles.hint}>
          {drawMode === 'start'
            ? 'Tap the grid to set your starting position (orange ring)'
            : drawShape === 'rect'
            ? 'Drag to draw a rectangle — release to fill. Great for buildings and ponds.'
            : drawShape === 'fill'
            ? 'Tap inside any closed boundary to flood-fill the area instantly.'
            : precisionMode
            ? 'Tap only — each tap draws exactly one cell. Zoom in for fine detail.'
            : drawMode === 'driveway'
            ? 'Tap or drag to mark driveway cells — mower crosses but does not cut'
            : 'Tap or drag to paint. Use Rectangle or Fill for faster accurate shapes.'}
        </Text>

        {/* Action buttons */}
        <View style={[styles.row, { marginTop: 16 }]}>
          <TouchableOpacity style={styles.btnPrimary} onPress={handleCalculate}>
            <Text style={styles.btnPrimaryText}>Calculate path</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnSecondary, history.length === 0 && { opacity: 0.4 }]}
            onPress={handleUndo}
            disabled={history.length === 0}
          >
            <Text style={styles.btnSecondaryText}>↩ Undo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnSecondary} onPress={handleClearObstacles}>
            <Text style={styles.btnSecondaryText}>Clear obstacles</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnSecondary} onPress={handleReset}>
            <Text style={styles.btnSecondaryText}>Reset</Text>
          </TouchableOpacity>
        </View>

        {/* Grid */}
        <View style={styles.gridContainer}>
          <ZoomableGrid
            zoom={zoom}
            setZoom={setZoom}
          >
            <GridCanvas
              gridCols={gridCols}
              gridRows={gridRows}
              cellSize={cellSize}
              obstacles={obstacles}
              effectiveObstacles={effectiveObstacles}
              driveways={driveways}
              effectiveDriveways={effectiveDriveways}
              path={path}
              animStep={animStep}
              direction={direction}
              drawMode={drawMode}
              drawShape={drawShape}
              precisionMode={precisionMode}
              startCell={startCell}
              selectedGroup={selectedGroup}
              onDrawStart={handleDrawStart}
              onSelectGroup={handleSelectGroup}
              onDeselectGroup={handleDeselectGroup}
              onMoveCommit={handleMoveCommit}
              onCellToggle={handleCellToggle}
              onStartSet={handleStartSet}
            />
          </ZoomableGrid>
          <View style={styles.zoomButtons}>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(Math.min(ZOOM_MAX, zoom * 1.5))}>
              <Text style={styles.zoomBtnText}>+</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(Math.min(ZOOM_MAX, zoom * 1.15))}>
              <Text style={styles.zoomBtnText}>+·</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(1)}>
              <Text style={styles.zoomBtnText}>⊙</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(Math.max(ZOOM_MIN, zoom / 1.15))}>
              <Text style={styles.zoomBtnText}>·−</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(Math.max(ZOOM_MIN, zoom / 1.5))}>
              <Text style={styles.zoomBtnText}>−</Text>
            </TouchableOpacity>
            <View style={styles.zoomLabel}>
              <Text style={styles.zoomLabelText}>{Math.round(zoom * 100)}%</Text>
            </View>
          </View>
        </View>

        {/* Animation done banner */}
        {animDone && (
          <TouchableOpacity style={styles.animDoneBanner} onPress={clearPath}>
            <Text style={styles.animDoneBannerText}>
              ✓ Mowing complete!{'  '}
              <Text style={styles.animDoneBannerAction}>Tap to try a new start / recalculate →</Text>
            </Text>
          </TouchableOpacity>
        )}

        {/* Animation controls */}
        {hasCalculated && path.length > 0 && (
          <View style={styles.animControls}>
            <TouchableOpacity
              style={[styles.animBtn, styles.btnPrimary]}
              onPress={() => {
                if (animating) {
                  stopAnim();
                } else {
                  const from = animStep < 0 || animStep >= path.length ? 0 : animStep;
                  startAnim(from);
                }
              }}
            >
              <Text style={styles.btnPrimaryText}>{animating ? '⏸ Pause' : animStep > 0 && animStep < path.length ? '▶ Resume' : '▶ Animate'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.animBtn, styles.btnSecondary]}
              onPress={clearPath}
            >
              <Text style={styles.btnSecondaryText}>🔄 Try New Start</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Legend */}
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: COLORS.greenDark }]} />
            <Text style={styles.legendText}>Start</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: COLORS.red }]} />
            <Text style={styles.legendText}>Finish</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: COLORS.green, borderRadius: 2, width: 18, height: 4 }]} />
            <Text style={styles.legendText}>Path</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: COLORS.gray, borderRadius: 2 }]} />
            <Text style={styles.legendText}>Obstacle</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: COLORS.driveway, borderRadius: 2 }]} />
            <Text style={styles.legendText}>Driveway</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#F59E0B', borderRadius: 2, width: 18, height: 4 }]} />
            <Text style={styles.legendText}>Route around</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: 'transparent', borderRadius: 6, borderWidth: 2, borderColor: '#F59E0B' }]} />
            <Text style={styles.legendText}>Start point</Text>
          </View>
        </View>

        {/* Stats */}
        {stats && (
          <>
            <SectionHeader title="Summary" />
            <View style={styles.statsGrid}>
              <StatCard label="Total strips" value={String(stats.strips)} />
              <StatCard label="Distance" value={`${Math.round(stats.distanceFt)} ft`} />
              <StatCard label="Turns" value={String(stats.turns)} />
              <StatCard label="Est. time" value={formatTime(stats.estimatedMinutes)} />
            </View>

            {/* Tabs */}
            <View style={styles.tabs}>
              <TouchableOpacity
                style={[styles.tab, activeTab === 'visual' && styles.tabActive]}
                onPress={() => setActiveTab('visual')}
              >
                <Text style={[styles.tabText, activeTab === 'visual' && styles.tabTextActive]}>
                  Visual path
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tab, activeTab === 'directions' && styles.tabActive]}
                onPress={() => setActiveTab('directions')}
              >
                <Text style={[styles.tabText, activeTab === 'directions' && styles.tabTextActive]}>
                  Turn-by-turn
                </Text>
              </TouchableOpacity>
            </View>

            {activeTab === 'visual' && (
              <Text style={styles.visualHint}>
                Green dot = start, red dot = finish. Path shown on grid above.
                {'\n'}Strip numbers appear on each lane when zoomed in.
              </Text>
            )}

            {activeTab === 'directions' && (
              <View style={styles.directionsList}>
                {directions.map((step, idx) => (
                  <View key={step.id} style={[styles.directionItem, step.isAction && styles.directionTurn]}>
                    <Text style={styles.directionNum}>{idx + 1}</Text>
                    <Text style={[styles.directionText, step.isAction && styles.directionTurnText]}>
                      {step.text}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background },
  scroll: { flex: 1 },
  container: { padding: 16 },
  title: {
    fontSize: 22,
    fontWeight: '500',
    color: COLORS.textPrimary,
    marginBottom: 20,
  },
  sectionHeader: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: 8,
    marginTop: 4,
  },
  row: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  inputGroup: { flex: 1, minWidth: 80 },
  inputLabel: { fontSize: 12, color: COLORS.textSecondary, marginBottom: 4 },
  input: {
    height: 40,
    borderWidth: 0.5,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 15,
    color: COLORS.textPrimary,
    backgroundColor: COLORS.surface,
  },
  toggleBtn: {
    flex: 1,
    height: 36,
    borderWidth: 0.5,
    borderColor: COLORS.border,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
  },
  toggleBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  toggleBtnBest: { backgroundColor: 'rgba(29,158,117,0.12)', borderColor: COLORS.green },
  toggleBtnStart: { backgroundColor: '#F59E0B', borderColor: '#F59E0B' },
  toggleBtnDriveway: { backgroundColor: '#78716C', borderColor: '#78716C' },
  toggleBtnDanger: { backgroundColor: '#A32D2D', borderColor: '#A32D2D' },
  toggleBtnInfo: { backgroundColor: '#185FA5', borderColor: '#185FA5' },
  toggleBtnMove: { backgroundColor: '#7C3AED', borderColor: '#7C3AED' },
  nudgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  nudgeLabel: { fontSize: 12, color: COLORS.textSecondary },
  nudgeCross: { alignItems: 'center', gap: 2 },
  nudgeMiddleRow: { flexDirection: 'row', gap: 2 },
  nudgeBtn: {
    width: 36, height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#7C3AED',
    backgroundColor: 'rgba(124,58,237,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nudgeBtnText: { fontSize: 14, color: '#7C3AED', fontWeight: '700' },
  toggleText: { fontSize: 13, color: COLORS.textSecondary },
  toggleTextActive: { color: '#fff', fontWeight: '500' },
  precisionBtn: {
    marginBottom: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignSelf: 'flex-start',
  },
  precisionBtnActive: {
    backgroundColor: '#5B21B6',
    borderColor: '#5B21B6',
  },
  precisionBtnText: { fontSize: 13, color: COLORS.textSecondary },
  precisionBtnTextActive: { color: '#fff', fontWeight: '500' },
  cornerGrid: { marginBottom: 12 },
  cornerRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  cornerBtn: {
    flex: 1,
    height: 40,
    borderWidth: 0.5,
    borderColor: COLORS.border,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
  },
  cornerBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  cornerBtnText: { fontSize: 13, color: COLORS.textSecondary },
  cornerBtnTextActive: { color: '#fff', fontWeight: '500' },
  hint: { fontSize: 12, color: COLORS.textTertiary, marginBottom: 12 },
  btnPrimary: {
    flex: 2,
    height: 40,
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  btnSecondary: {
    flex: 1,
    height: 40,
    borderWidth: 0.5,
    borderColor: COLORS.border,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
  },
  btnSecondaryText: { color: COLORS.textPrimary, fontSize: 13 },
  gridContainer: {
    borderWidth: 0.5,
    borderColor: COLORS.border,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: COLORS.background,
    marginBottom: 4,
  },
  zoomButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 6,
    marginBottom: 8,
    paddingRight: 2,
  },
  zoomBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBtnText: {
    fontSize: 14,
    color: COLORS.textPrimary,
    lineHeight: 18,
    fontWeight: '600',
  },
  zoomLabel: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    minWidth: 44,
  },
  zoomLabelText: {
    fontSize: 11,
    color: COLORS.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  animDoneBanner: {
    backgroundColor: '#1D9E75',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 10,
    alignItems: 'center',
  },
  animDoneBannerText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  animDoneBannerAction: {
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '400',
    fontSize: 13,
  },
  animControls: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  animBtn: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridWrapper: { overflow: 'hidden' },
  legend: { flexDirection: 'row', gap: 14, flexWrap: 'wrap', marginBottom: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 11, height: 11, borderRadius: 6 },
  legendText: { fontSize: 12, color: COLORS.textSecondary },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  statCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: COLORS.background,
    borderRadius: 8,
    padding: 12,
    borderWidth: 0.5,
    borderColor: COLORS.border,
  },
  statLabel: { fontSize: 12, color: COLORS.textSecondary },
  statValue: { fontSize: 18, fontWeight: '500', color: COLORS.textPrimary, marginTop: 2 },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
    marginBottom: 8,
  },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: COLORS.primary },
  tabText: { fontSize: 13, color: COLORS.textSecondary },
  tabTextActive: { color: COLORS.textPrimary, fontWeight: '500' },
  visualHint: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 20, marginBottom: 8 },
  directionsList: {
    borderWidth: 0.5,
    borderColor: COLORS.border,
    borderRadius: 8,
    overflow: 'hidden',
  },
  directionItem: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  directionTurn: { backgroundColor: '#F5F9FF' },
  directionNum: { fontSize: 12, color: COLORS.textTertiary, minWidth: 22, paddingTop: 1 },
  directionText: { flex: 1, fontSize: 13, color: COLORS.textSecondary, lineHeight: 18 },
  directionTurnText: { color: '#185FA5', fontWeight: '500' },
});
