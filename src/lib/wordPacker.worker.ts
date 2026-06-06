import type {
  PackComputationResult,
  PackOptions,
  PackPlacement,
  PackResult,
  WordPackerWorkerRequest,
  WordPackerWorkerResponse,
} from "./wordPacker";
import { segmentRegions, type PixelSet, type ShapeRegions } from "./shapeRegions";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type RegionKey = keyof ShapeRegions;

interface RegionCoverage {
  region: RegionKey;
  total: number;
  filled: number;
  ratio: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function maskAt(mask: Uint8Array, maskSize: number, nx: number, ny: number): boolean {
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return false;
  const mx = Math.min(maskSize - 1, Math.floor(nx * maskSize));
  const my = Math.min(maskSize - 1, Math.floor(ny * maskSize));
  return mask[my * maskSize + mx] === 1;
}

// Edge-hugging containment: 4 corners + center only. Fewer test points let
// words approach within ~1-3px of silhouette edges (reference Etsy art).
function boxInsideMask(
  mask: Uint8Array,
  maskSize: number,
  box: Box,
  width: number,
  height: number,
  padPx: number,
): boolean {
  const x0 = box.x + padPx;
  const y0 = box.y + padPx;
  const w = box.w - 2 * padPx;
  const h = box.h - 2 * padPx;
  if (w <= 0 || h <= 0) return false;
  const x1 = x0 + w;
  const y1 = y0 + h;
  const mx = x0 + w / 2;
  const my = y0 + h / 2;
  const pts: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
    [mx, my],
  ];
  for (const [px, py] of pts) {
    if (!maskAt(mask, maskSize, px / width, py / height)) return false;
  }
  return true;
}

function rectsOverlap(a: Box, b: Box): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

class Grid {
  cells: Map<string, Box[]> = new Map();
  cellSize: number;
  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }
  key(cx: number, cy: number) {
    return `${cx},${cy}`;
  }
  add(b: Box) {
    const x0 = Math.floor(b.x / this.cellSize);
    const y0 = Math.floor(b.y / this.cellSize);
    const x1 = Math.floor((b.x + b.w) / this.cellSize);
    const y1 = Math.floor((b.y + b.h) / this.cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = this.key(x, y);
        const arr = this.cells.get(k);
        if (arr) arr.push(b);
        else this.cells.set(k, [b]);
      }
    }
  }
  collides(b: Box): boolean {
    const x0 = Math.floor(b.x / this.cellSize);
    const y0 = Math.floor(b.y / this.cellSize);
    const x1 = Math.floor((b.x + b.w) / this.cellSize);
    const y1 = Math.floor((b.y + b.h) / this.cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const arr = this.cells.get(this.key(x, y));
        if (!arr) continue;
        for (const o of arr) if (rectsOverlap(b, o)) return true;
      }
    }
    return false;
  }
}

function createMeasureContext(): OffscreenCanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  return new OffscreenCanvas(1, 1).getContext("2d");
}

const measureCtx = createMeasureContext();

function measureWord(
  word: string,
  fontSize: number,
  fontFamily: string,
  fontWeight: number,
): number {
  if (measureCtx) {
    measureCtx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    return measureCtx.measureText(word).width;
  }
  return word.length * fontSize * 0.58;
}

// --- Color helpers ---------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(a: string, b: string, t: number): string {
  const ra = hexToRgb(a),
    rb = hexToRgb(b);
  if (!ra || !rb) return a;
  return rgbToHex(
    ra[0] + (rb[0] - ra[0]) * t,
    ra[1] + (rb[1] - ra[1]) * t,
    ra[2] + (rb[2] - ra[2]) * t,
  );
}
function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}
function colorsClose(a: string, b: string, tol = 0.08): boolean {
  return Math.abs(luminance(a) - luminance(b)) < tol;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeMaskBounds(mask: Uint8Array, size: number) {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      if (mask[row + x] !== 1) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    return { minX: 0, minY: 0, maxX: size - 1, maxY: size - 1 };
  }
  return { minX, minY, maxX, maxY };
}

function remapMaskForFrame(
  sourceMask: Uint8Array,
  maskSize: number,
  targetFillMin = 0.7,
  targetFillMax = 0.85,
): Uint8Array {
  const { minX, minY, maxX, maxY } = computeMaskBounds(sourceMask, maskSize);
  const srcW = Math.max(1, maxX - minX + 1);
  const srcH = Math.max(1, maxY - minY + 1);
  // Frameable scale mode: target 70–80% of page height (midpoint = 75%).
  const targetFill = clamp((targetFillMin + targetFillMax) / 2, 0.1, 0.98);
  const targetH = maskSize * targetFill;
  const scaleByH = targetH / srcH;
  // Enforce minimum 5% margin on all sides: silhouette width must not exceed
  // 90% of the canvas width. For wide silhouettes this prevents overflow/clipping
  // and guarantees margins are always within the 5–15% range on every edge.
  const MARGIN_MIN = 0.05;
  const scaleByW = (maskSize * (1 - 2 * MARGIN_MIN)) / srcW;
  // Use the smaller scale so both constraints are satisfied simultaneously,
  // while keeping the silhouette as large as possible (never center a small
  // silhouette inside a large empty page).
  const scale = Math.min(scaleByH, scaleByW);
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;
  const offsetX = (maskSize - scaledW) / 2;
  const offsetY = (maskSize - scaledH) / 2;

  const out = new Uint8Array(maskSize * maskSize);
  for (let y = 0; y < maskSize; y++) {
    for (let x = 0; x < maskSize; x++) {
      const srcX = minX + (x - offsetX) / scale;
      const srcY = minY + (y - offsetY) / scale;
      const ix = Math.floor(srcX);
      const iy = Math.floor(srcY);
      if (ix < 0 || ix >= maskSize || iy < 0 || iy >= maskSize) continue;
      out[y * maskSize + x] = sourceMask[iy * maskSize + ix] === 1 ? 1 : 0;
    }
  }
  return out;
}

function scoreProfileSimilarity(maskProfile: number[], occupiedProfile: number[]): number {
  if (maskProfile.length === 0) return 0;
  let totalDiff = 0;
  for (let i = 0; i < maskProfile.length; i++) {
    totalDiff += Math.abs(maskProfile[i] - occupiedProfile[i]);
  }
  return clamp(1 - totalDiff / maskProfile.length, 0, 1);
}

interface DistanceField {
  width: number;
  height: number;
  insideDistance: Float32Array;
  outsideDistance: Float32Array;
  contourPixels: Uint8Array;
}

const DISTANCE_FIELD_INF = 1e12;

function distanceTransform1D(values: Float32Array, length: number): Float32Array {
  const distances = new Float32Array(length);
  const vertices = new Int32Array(length);
  const intersections = new Float64Array(length + 1);
  let firstFinite = -1;
  for (let i = 0; i < length; i++) {
    if (values[i] < DISTANCE_FIELD_INF) {
      firstFinite = i;
      break;
    }
  }
  if (firstFinite === -1) {
    distances.fill(DISTANCE_FIELD_INF);
    return distances;
  }

  let k = 0;
  vertices[0] = firstFinite;
  intersections[0] = -Infinity;
  intersections[1] = Infinity;

  for (let q = firstFinite + 1; q < length; q++) {
    if (values[q] >= DISTANCE_FIELD_INF) continue;
    let s =
      (values[q] + q * q - (values[vertices[k]] + vertices[k] * vertices[k])) /
      (2 * q - 2 * vertices[k]);
    while (k > 0 && s <= intersections[k]) {
      k--;
      s =
        (values[q] + q * q - (values[vertices[k]] + vertices[k] * vertices[k])) /
        (2 * q - 2 * vertices[k]);
    }
    k++;
    vertices[k] = q;
    intersections[k] = s;
    intersections[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < length; q++) {
    while (intersections[k + 1] < q) k++;
    const delta = q - vertices[k];
    distances[q] = delta * delta + values[vertices[k]];
  }

  return distances;
}

function distanceTransform2D(source: Float32Array, width: number, height: number): Float32Array {
  const columnPass = new Float32Array(width * height);
  for (let x = 0; x < width; x++) {
    const column = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      column[y] = source[y * width + x];
    }
    const columnDistances = distanceTransform1D(column, height);
    for (let y = 0; y < height; y++) {
      columnPass[y * width + x] = columnDistances[y];
    }
  }

  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = columnPass.subarray(y * width, (y + 1) * width);
    output.set(distanceTransform1D(row, width), y * width);
  }

  return output;
}

function buildSignedDistanceField(mask: Uint8Array, width: number, height = width): DistanceField {
  const contourPixels = new Uint8Array(width * height);
  let contourCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] !== 1) continue;
      const up = y > 0 ? mask[i - width] : 0;
      const dn = y < height - 1 ? mask[i + width] : 0;
      const lf = x > 0 ? mask[i - 1] : 0;
      const rt = x < width - 1 ? mask[i + 1] : 0;
      if (!up || !dn || !lf || !rt) {
        contourPixels[i] = 1;
        contourCount++;
      }
    }
  }

  const insideDistance = new Float32Array(width * height);
  const outsideDistance = new Float32Array(width * height);
  if (contourCount === 0) {
    return { width, height, insideDistance, outsideDistance, contourPixels };
  }

  const contourSource = new Float32Array(width * height);
  for (let i = 0; i < contourSource.length; i++) {
    contourSource[i] = contourPixels[i] === 1 ? 0 : DISTANCE_FIELD_INF;
  }

  const squaredDistances = distanceTransform2D(contourSource, width, height);
  for (let i = 0; i < squaredDistances.length; i++) {
    const distance = Math.sqrt(squaredDistances[i]);
    if (mask[i] === 1) insideDistance[i] = distance;
    else outsideDistance[i] = distance;
  }

  return { width, height, insideDistance, outsideDistance, contourPixels };
}

function buildPalette(opts: PackOptions): {
  dark: string;
  mid: string;
  light: string;
  accent: string;
} {
  const primary = opts.primaryColor ?? "#000000";
  const accent = opts.accentColor;
  const bg = opts.bgColor ?? "#FFFFFF";
  const src = (
    opts.palette && opts.palette.length > 0
      ? opts.palette
      : [primary, accent, mix(primary, bg, 0.55)]
  ).filter((c) => hexToRgb(c));
  // sort dark → light by luminance
  const sorted = [...src].sort((a, b) => luminance(a) - luminance(b));
  const dark = sorted[0] ?? primary;
  const light = sorted[sorted.length - 1] ?? mix(primary, bg, 0.55);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? accent;
  // Contrast guard: any color too close to bg → fall back
  const safe = (c: string) => (colorsClose(c, bg) ? primary : c);
  return { dark: safe(dark), mid: safe(mid), light: safe(light), accent: safe(accent) };
}

// --- Main packer -----------------------------------------------------------

function computePlacements(
  mask: Uint8Array,
  maskSize: number,
  opts: PackOptions,
): PackComputationResult {
  const occupancyMin = clamp(opts.occupancyMin ?? 0.82, 0.5, 0.9);
  const occupancyTarget = clamp(opts.occupancyTarget ?? 0.86, occupancyMin, 0.9);
  const occupancyMax = clamp(opts.occupancyMax ?? 0.9, occupancyTarget, 0.92);
  const silhouetteMin = clamp(opts.silhouetteSimilarityThreshold ?? 0.88, 0, 1);
  // Horizontal ratio gate is removed: angled text legitimately reduces it.
  const horizontalMin = clamp(opts.orientationHorizontalMin ?? 0.55, 0.3, 1);
  const horizontalMax = clamp(opts.orientationHorizontalMax ?? 0.9, horizontalMin, 1);
  const frameMask = remapMaskForFrame(
    mask,
    maskSize,
    opts.canvasHeightFillMin ?? 0.7,
    opts.canvasHeightFillMax ?? 0.8,
  );

  const { width, height } = opts;

  // --- Mask bounding box (in canvas pixel space) ---
  // Font sizes & search seeding scale to the SILHOUETTE, not the canvas, so a
  // small mask inside a large canvas still gets correctly-sized words.
  let mnX = maskSize,
    mnY = maskSize,
    mxX = -1,
    mxY = -1;
  for (let y = 0; y < maskSize; y++) {
    const row = y * maskSize;
    for (let x = 0; x < maskSize; x++) {
      if (frameMask[row + x] === 1) {
        if (x < mnX) mnX = x;
        if (x > mxX) mxX = x;
        if (y < mnY) mnY = y;
        if (y > mxY) mxY = y;
      }
    }
  }
  if (mxX < 0) {
    mnX = 0;
    mnY = 0;
    mxX = maskSize - 1;
    mxY = maskSize - 1;
  }
  const bboxX = (mnX / maskSize) * width;
  const bboxY = (mnY / maskSize) * height;
  const bboxW = ((mxX - mnX + 1) / maskSize) * width;
  const bboxH = ((mxY - mnY + 1) / maskSize) * height;
  const shapeH = bboxH;
  const shapeMin = Math.min(bboxW, bboxH);

  // Edge-hug pad — words can sit ~1-2px from silhouette outline.
  const EDGE_PAD = Math.max(1, shapeMin * 0.001);

  // --- Occupancy grid (distributed seeding + real coverage %) ---
  const OG = 220;
  const cellW = width / OG;
  const cellH = height / OG;
  const inMask = new Uint8Array(OG * OG);
  let maskCellCount = 0;
  for (let y = 0; y < OG; y++) {
    for (let x = 0; x < OG; x++) {
      const nx = (x + 0.5) / OG;
      const ny = (y + 0.5) / OG;
      const mxi = Math.min(maskSize - 1, Math.floor(nx * maskSize));
      const myi = Math.min(maskSize - 1, Math.floor(ny * maskSize));
      if (frameMask[myi * maskSize + mxi] === 1) {
        inMask[y * OG + x] = 1;
        maskCellCount++;
      }
    }
  }
  const occupied = new Uint8Array(OG * OG);
  let occupiedCount = 0;

  const isEmptyCell = (i: number) => inMask[i] === 1 && occupied[i] === 0;
  const cellToSeed = (i: number) => ({
    x: ((i % OG) + 0.5) * cellW,
    y: (Math.floor(i / OG) + 0.5) * cellH,
  });

  const contourDistanceField = buildSignedDistanceField(inMask, OG);
  const contourBand: PixelSet = [];
  const interiorCells: PixelSet = [];
  const shapeRegions = segmentRegions(inMask, OG);
  const contourBandRadiusPx = 8;
  const pxPerCell = (cellW + cellH) * 0.5;
  for (let i = 0; i < OG * OG; i++) {
    if (inMask[i] !== 1) continue;
    const distancePx = contourDistanceField.insideDistance[i] * pxPerCell;
    if (distancePx <= contourBandRadiusPx) contourBand.push(i);
    else interiorCells.push(i);
  }

  function computeRegionCoverage(): RegionCoverage[] {
    const regions: RegionKey[] = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];
    return regions
      .map((region) => {
        const cells = shapeRegions[region];
        let total = 0;
        let filled = 0;
        for (const i of cells) {
          if (inMask[i] !== 1) continue;
          total++;
          if (occupied[i] === 1) filled++;
        }
        return {
          region,
          total,
          filled,
          ratio: total === 0 ? 0 : filled / total,
        };
      })
      .filter((entry) => entry.total > 0);
  }

  function getSparseRegions(targetRatio = 0.34): RegionCoverage[] {
    return computeRegionCoverage()
      .filter((entry) => entry.ratio < targetRatio)
      .sort((a, b) => a.ratio - b.ratio || b.total - a.total);
  }

  function collectRowRuns(
    row: number,
  ): Array<{ start: number; end: number; center: number; width: number }> {
    if (row < 0 || row >= OG) return [];
    const runs: Array<{ start: number; end: number; center: number; width: number }> = [];
    let start = -1;
    for (let x = 0; x <= OG; x++) {
      const active = x < OG ? inMask[row * OG + x] === 1 : false;
      if (active && start < 0) {
        start = x;
        continue;
      }
      if (!active && start >= 0) {
        const end = x - 1;
        const widthCells = end - start + 1;
        runs.push({
          start,
          end,
          center: (start + end + 1) * 0.5,
          width: widthCells * cellW,
        });
        start = -1;
      }
    }
    return runs;
  }

  function markBoxOcc(box: Box) {
    const cx0 = Math.max(0, Math.floor(box.x / cellW));
    const cy0 = Math.max(0, Math.floor(box.y / cellH));
    const cx1 = Math.min(OG - 1, Math.floor((box.x + box.w) / cellW));
    const cy1 = Math.min(OG - 1, Math.floor((box.y + box.h) / cellH));
    for (let yy = cy0; yy <= cy1; yy++) {
      for (let xx = cx0; xx <= cx1; xx++) {
        const i = yy * OG + xx;
        if (inMask[i] === 1 && occupied[i] === 0) {
          occupied[i] = 1;
          occupiedCount++;
        }
      }
    }
  }

  // Pick a random empty in-mask cell as a placement seed.
  function pickEmptySeed(): { x: number; y: number } | null {
    for (let t = 0; t < 120; t++) {
      const i = Math.floor(Math.random() * OG * OG);
      if (isEmptyCell(i)) return cellToSeed(i);
    }
    return null;
  }

  function pickContourSeed(band: PixelSet): { x: number; y: number } | null {
    if (band.length === 0) return null;
    for (let t = 0; t < 140; t++) {
      const i = band[Math.floor(Math.random() * band.length)];
      if (!isEmptyCell(i)) continue;
      return cellToSeed(i);
    }
    return null;
  }

  function pickInteriorSeed(): { x: number; y: number } | null {
    if (interiorCells.length > 0) {
      for (let t = 0; t < 140; t++) {
        const i = interiorCells[Math.floor(Math.random() * interiorCells.length)];
        if (!isEmptyCell(i)) continue;
        return cellToSeed(i);
      }
    }
    return pickEmptySeed();
  }

  const boundaryIndices: number[] = [];
  for (let y = 0; y < OG; y++) {
    for (let x = 0; x < OG; x++) {
      const i = y * OG + x;
      if (inMask[i] !== 1) continue;
      const up = y > 0 ? inMask[i - OG] : 0;
      const dn = y < OG - 1 ? inMask[i + OG] : 0;
      const lf = x > 0 ? inMask[i - 1] : 0;
      const rt = x < OG - 1 ? inMask[i + 1] : 0;
      if (!up || !dn || !lf || !rt) boundaryIndices.push(i);
    }
  }

  function pickBoundarySeed(): { x: number; y: number } | null {
    if (boundaryIndices.length === 0) return pickEmptySeed();
    for (let t = 0; t < 120; t++) {
      const i = boundaryIndices[Math.floor(Math.random() * boundaryIndices.length)];
      if (!isEmptyCell(i)) continue;
      return cellToSeed(i);
    }
    return pickEmptySeed();
  }

  function pickRegionSeed(region: keyof ShapeRegions): {
    x: number;
    y: number;
  } | null {
    const regionCells = shapeRegions[region];
    for (let t = 0; t < 120; t++) {
      const i = regionCells[Math.floor(Math.random() * Math.max(1, regionCells.length))];
      if (i == null || !isEmptyCell(i)) continue;
      return cellToSeed(i);
    }
    return pickInteriorSeed() ?? pickContourSeed(contourBand) ?? pickEmptySeed();
  }

  function buildNameAnchors(): Array<{ x: number; y: number; maxWidth: number }> {
    const candidateRows = new Set<number>();
    const pushRow = (value: number) => {
      candidateRows.add(clamp(Math.round(value), 0, OG - 1));
    };
    pushRow((cy / height) * OG);
    pushRow((mnY + (mxY - mnY) * 0.42) * (OG / maskSize));
    pushRow((mnY + (mxY - mnY) * 0.5) * (OG / maskSize));
    pushRow((mnY + (mxY - mnY) * 0.58) * (OG / maskSize));

    const torsoRows = new Set<number>();
    for (const cell of shapeRegions.torso) torsoRows.add(Math.floor(cell / OG));
    for (const row of torsoRows) {
      pushRow(row);
      pushRow(row - 2);
      pushRow(row + 2);
    }

    const anchors = [...candidateRows]
      .flatMap((row) =>
        collectRowRuns(row).map((run) => ({
          x: run.center * cellW,
          y: (row + 0.5) * cellH,
          maxWidth: Math.max(0, run.width - cellW * 2),
          score:
            run.width -
            Math.abs(run.center * cellW - cx) * 0.65 -
            Math.abs((row + 0.5) * cellH - cy) * 0.45,
        })),
      )
      .filter((anchor) => anchor.maxWidth > cellW * 6)
      .sort((a, b) => b.score - a.score);

    return anchors.map(({ x, y, maxWidth }) => ({ x, y, maxWidth }));
  }

  const palette = buildPalette(opts);
  const bodyFont = opts.bodyFontFamily ?? opts.fontFamily;
  const nameFont = opts.nameFontFamily ?? opts.fontFamily;
  // Finer collision grid → tighter packing between neighbors.
  const grid = new Grid(Math.max(8, shapeMin / 80));

  const etsy = !!opts.etsyMode;
  const scaleMul = 1 + (opts.scaling - 10) / 40;
  const emphasisMul = 0.8 + opts.emphasis * 0.1;
  const randomness = (opts.randomness / 100) * (etsy ? 0.6 : 1);
  const adherence = opts.adherence / 100;

  // Center placements on the silhouette centroid, not the canvas.
  const cx = bboxX + bboxW / 2;
  const cy = bboxY + bboxH / 2;

  const sorted = [...opts.words].sort((a, b) => b.importanceScore - a.importanceScore);
  const nameEntry = sorted.find((w) => w.word.toLowerCase() === opts.name.toLowerCase());
  if (!nameEntry) sorted.unshift({ word: opts.name, category: "Name", importanceScore: 1000 });

  const rest = sorted.filter((w) => w.word.toLowerCase() !== opts.name.toLowerCase());
  const tier2 = rest.filter((w) => w.importanceScore >= 85).slice(0, etsy ? 6 : 10);
  const tier3 = rest
    .filter((w) => w.importanceScore >= 40 && w.importanceScore < 85)
    .slice(0, etsy ? 55 : 80);
  const tier4 = rest
    .filter((w) => w.importanceScore >= 10 && w.importanceScore < 40)
    .slice(0, etsy ? 140 : 200);
  // Tier 5 = mortar; dedupe against everything already scheduled so words don't repeat.
  const usedKeys = new Set<string>([
    opts.name.toLowerCase(),
    ...tier2.map((w) => w.word.toLowerCase()),
    ...tier3.map((w) => w.word.toLowerCase()),
    ...tier4.map((w) => w.word.toLowerCase()),
  ]);
  const pool = rest.filter((w) => !usedKeys.has(w.word.toLowerCase()));
  const tier5Cap = pool.length > 0 ? (etsy ? 240 : 500) : 0;

  const totalUnits = Math.max(1, 1 + tier2.length + tier3.length + tier4.length + tier5Cap);
  let completedUnits = 0;
  let lastProgress = -1;

  const placements: PackPlacement[] = [];
  const uniqueWordsSeen = new Set<string>();
  const wordCounts = new Map<string, number>();
  let placedInsideMask = 0;
  let placedTotal = 0;
  let accentPlacements = 0;
  let leftWeight = 0;
  let rightWeight = 0;
  let topWeight = 0;
  let bottomWeight = 0;
  let horizontalPlacements = 0;
  let verticalPlacements = 0;
  let nameArea = 0;
  let maxNonNameArea = 1;

  const sendProgress = (force = false) => {
    const progress = force ? 100 : Math.min(99, Math.round((completedUnits / totalUnits) * 100));
    if (force || progress > lastProgress) {
      const message: WordPackerWorkerResponse = { type: "progress", progress };
      self.postMessage(message);
      lastProgress = progress;
    }
  };

  function trackPlacement(word: string, box: Box, color: string, angle: number) {
    const key = word.toLowerCase();
    wordCounts.set(key, (wordCounts.get(key) ?? 0) + 1);
    uniqueWordsSeen.add(key);
    if (color === palette.accent) accentPlacements++;
    const area = box.w * box.h;
    if (key === opts.name.toLowerCase()) nameArea = area;
    else if (area > maxNonNameArea) maxNonNameArea = area;
    const midX = box.x + box.w / 2;
    const midY = box.y + box.h / 2;
    if (midX < cx) leftWeight += area;
    else rightWeight += area;
    if (midY < cy) topWeight += area;
    else bottomWeight += area;
    if (Math.abs(angle) > 0.001) verticalPlacements++;
    else horizontalPlacements++;
  }

  // Angle palette: 0° for name/tier-2, a richer set including diagonals for
  // tiers 3–5, especially when seeding from boundary cells.
  const ANGLED_PALETTE = [
    0,
    0,
    0, // 3× horizontal – most common
    Math.PI / 12, // +15°
    -Math.PI / 12, // -15°
    Math.PI / 6, // +30°
    -Math.PI / 6, // -30°
    Math.PI / 4, // +45°
    -Math.PI / 4, // -45°
    Math.PI / 2, // 90°
  ] as const;

  function pickAngle(tier: 2 | 3 | 4 | 5, nearBoundary = false): number {
    if (tier < 3) return 0; // name and anchors stay horizontal
    // Near silhouette edges allow wider angle range; interior prefers horizontal.
    const palette = nearBoundary ? ANGLED_PALETTE : ANGLED_PALETTE.slice(0, 5);
    return palette[Math.floor(Math.random() * palette.length)];
  }

  // tier: 2 | 3 | 4 | 5  → controls rotation policy & attempt budget
  function place(
    word: string,
    fontSize: number,
    color: string,
    tier: 2 | 3 | 4 | 5,
    fontFamily: string,
    fontWeight: number,
    seed?: { x: number; y: number } | null,
    nearBoundary = false,
  ): boolean {
    const angle = pickAngle(tier, nearBoundary);
    const tw = measureWord(word, fontSize, fontFamily, fontWeight);
    const th = fontSize * 1.05;
    // Compute axis-aligned bounding box for any rotation angle.
    const cosA = Math.abs(Math.cos(angle));
    const sinA = Math.abs(Math.sin(angle));
    const bw = tw * cosA + th * sinA;
    const bh = tw * sinA + th * cosA;

    // Distributed seeding: each word starts at an empty-region seed (not
    // canvas center), so torsos don't hog space while arms/legs stay empty.
    const ox = seed?.x ?? cx;
    const oy = seed?.y ?? cy;

    const startR = Math.max(2, fontSize * 0.3);
    const maxR = Math.max(bboxW, bboxH);
    const step = Math.max(1, fontSize * 0.08 * (1 + randomness));
    const maxAttempts = tier === 5 ? 900 : tier === 4 ? 1800 : 3000;
    let r = startR;
    let theta = Math.random() * Math.PI * 2;

    const pad = Math.max(0.5, Math.min(fontSize * 0.08, 1 + fontSize * 0.02 * adherence));

    for (let i = 0; i < maxAttempts; i++) {
      const x = ox + Math.cos(theta) * r;
      const y = oy + Math.sin(theta) * r;
      const box: Box = { x: x - bw / 2, y: y - bh / 2, w: bw, h: bh };

      if (
        box.x < EDGE_PAD ||
        box.y < EDGE_PAD ||
        box.x + box.w > width - EDGE_PAD ||
        box.y + box.h > height - EDGE_PAD
      ) {
        theta += GOLDEN_ANGLE;
        r += step * 0.1;
        continue;
      }

      if (!boxInsideMask(frameMask, maskSize, box, width, height, pad)) {
        theta += GOLDEN_ANGLE;
        r += step * 0.05;
        continue;
      }

      if (!grid.collides(box)) {
        grid.add(box);
        placements.push({ x, y, word, fontSize, color, angle, fontFamily, fontWeight });
        trackPlacement(word, box, color, angle);
        markBoxOcc(box);
        placedTotal++;
        placedInsideMask++;
        return true;
      }

      theta += GOLDEN_ANGLE;
      r += step * 0.05;
      if (i % 50 === 0) r += step;
      if (r > maxR) r = startR + Math.random() * 20;
    }
    return false;
  }

  // Try multiple seeds before giving up (gap-filling).
  // preferBoundary=true makes the first pass always try boundary seeds (edge-first strategy).
  function placeWithSeeds(
    word: string,
    fontSize: number,
    color: string,
    tier: 2 | 3 | 4 | 5,
    fontFamily: string,
    fontWeight: number,
    seedAttempts = 4,
    preferLarge = false,
    preferBoundary = false,
  ): boolean {
    for (let s = 0; s < seedAttempts; s++) {
      const isBoundarySeed = preferBoundary || s === 0;
      const seed =
        preferLarge && s === 0
          ? pickInteriorSeed()
          : isBoundarySeed
            ? pickBoundarySeed()
            : pickEmptySeed();
      if (place(word, fontSize, color, tier, fontFamily, fontWeight, seed, isBoundarySeed))
        return true;
    }
    // Final fallback: center spiral.
    return place(word, fontSize, color, tier, fontFamily, fontWeight, null, false);
  }

  // --- Pass 1 (student name): locked to center, registered first ---
  const nameText = (opts.name || "").trim();
  // Reference-art sizing: ~10% of SILHOUETTE height, with small emphasis nudge.
  const targetNameSize =
    shapeH * ((etsy ? 0.085 : 0.1) + 0.01 * Math.min(1, Math.max(-1, emphasisMul - 1))) * scaleMul;
  const nameAnchors = buildNameAnchors();
  const fallbackNameWidth = bboxW * 0.42;
  let nameSize = targetNameSize;
  if (nameText) {
    const minNameSize = Math.max(18, shapeH * 0.05);
    let bestNamePlacement: {
      x: number;
      y: number;
      fontSize: number;
      box: Box;
    } | null = null;
    const candidateAnchors = [...nameAnchors, { x: cx, y: cy, maxWidth: fallbackNameWidth }];
    for (const anchor of candidateAnchors) {
      let candidateSize = targetNameSize;
      let measured = measureWord(nameText, candidateSize, nameFont, 800);
      const allowedWidth = anchor.maxWidth > 0 ? anchor.maxWidth : fallbackNameWidth;
      if (measured > allowedWidth) candidateSize *= allowedWidth / measured;
      while (candidateSize >= minNameSize) {
        measured = measureWord(nameText, candidateSize, nameFont, 800);
        const candidateBox: Box = {
          x: anchor.x - measured / 2 - 6,
          y: anchor.y - candidateSize / 2 - 4,
          w: measured + 12,
          h: candidateSize + 8,
        };
        const namePad = Math.max(0.5, Math.min(2, candidateSize * 0.025));
        if (boxInsideMask(frameMask, maskSize, candidateBox, width, height, namePad)) {
          if (!bestNamePlacement || candidateSize > bestNamePlacement.fontSize) {
            bestNamePlacement = {
              x: anchor.x,
              y: anchor.y,
              fontSize: candidateSize,
              box: candidateBox,
            };
          }
          break;
        }
        candidateSize *= 0.94;
      }
    }

    if (!bestNamePlacement) {
      let measured = measureWord(nameText, nameSize, nameFont, 800);
      const allowedWidth = Math.max(fallbackNameWidth, bboxW * 0.35);
      if (measured > allowedWidth) nameSize = nameSize * (allowedWidth / measured);
      if (nameSize < minNameSize) nameSize = minNameSize;
      measured = measureWord(nameText, nameSize, nameFont, 800);
      bestNamePlacement = {
        x: cx,
        y: cy,
        fontSize: nameSize,
        box: {
          x: cx - measured / 2 - 6,
          y: cy - nameSize / 2 - 4,
          w: measured + 12,
          h: nameSize + 8,
        },
      };
    }

    nameSize = bestNamePlacement.fontSize;
    const nameBox = bestNamePlacement.box;
    grid.add(nameBox);
    markBoxOcc(nameBox);
    const nameColor = palette.dark;
    placements.push({
      word: nameText,
      x: bestNamePlacement.x,
      y: bestNamePlacement.y,
      fontSize: nameSize,
      color: nameColor,
      angle: 0,
      fontFamily: nameFont,
      fontWeight: 800,
    });
    trackPlacement(nameText, nameBox, nameColor, 0);
    placedTotal++;
    placedInsideMask++;
  }
  completedUnits++;
  sendProgress();

  // --- Pass 2 (anchor words): large, dark, boundary-first then large empty ---
  for (const w of tier2) {
    const fs = shapeH * (etsy ? 0.034 : 0.042 + Math.random() * 0.008) * scaleMul * emphasisMul;
    const color = Math.random() < 0.25 ? palette.accent : palette.dark;
    placeWithSeeds(w.word, fs, color, 2, bodyFont, 700, 5, true, true);
    completedUnits++;
    sendProgress();
  }

  // --- Pass 3 (medium words): boundary-first; enables diagonal angles near edges ---
  const unplacedMedium: typeof tier3 = [];
  for (const w of tier3) {
    const fs = shapeH * (etsy ? 0.015 : 0.017) * scaleMul;
    const color = Math.random() < 0.5 ? palette.dark : palette.mid;
    // Always start from boundary; fall back to empty interior on retries.
    const seed = pickBoundarySeed() ?? pickEmptySeed();
    const nearBoundary = true;
    const placed = place(w.word, fs, color, 3, bodyFont, 500, seed, nearBoundary);
    if (!placed) unplacedMedium.push(w);
    completedUnits++;
    sendProgress();
  }

  // --- Pass 4 (gap filling): small words, boundary-priority ---
  const unplacedSmall: typeof tier4 = [];
  for (const w of tier4) {
    const fs = shapeH * (etsy ? 0.0095 : 0.0105) + (Math.random() - 0.5) * 1.2;
    const color = Math.random() < 0.2 ? palette.accent : palette.mid;
    // 80% boundary seed → small words actively define the silhouette outline.
    const nearBoundary = Math.random() < 0.8;
    const seed = nearBoundary ? (pickBoundarySeed() ?? pickEmptySeed()) : pickEmptySeed();
    const placed = place(w.word, fs, color, 4, bodyFont, 400, seed, nearBoundary);
    if (!placed) unplacedSmall.push(w);
    completedUnits++;
    sendProgress();
  }

  // --- Pass 5+ (whitespace recovery): small → micro → rebalance ---
  if (pool.length > 0) {
    const MIN_FONT_PT = Math.max(shapeMin * 0.0025, shapeH * 0.0036);
    const startFs = Math.max(MIN_FONT_PT, shapeH * (etsy ? 0.0085 : 0.0095));
    const MAX_RECOVERY_CYCLES = etsy ? 28 : 18;
    const HARD_CAP = etsy ? 4200 : 9000;
    const perWordCap = 4;
    let i = 0;
    let cycle = 0;
    while (i < HARD_CAP && cycle < MAX_RECOVERY_CYCLES) {
      const coverageNow = maskCellCount === 0 ? 1 : occupiedCount / maskCellCount;
      const sparseRegions = getSparseRegions();
      if (coverageNow >= occupancyMax) break;
      if (coverageNow >= occupancyTarget && sparseRegions.length === 0) break;
      let cyclePlacements = 0;

      // 1) Detect emptier regions and fill with small contour-aware words.
      for (const w of unplacedMedium.slice(0, 24)) {
        const fs = shapeH * (etsy ? 0.014 : 0.016) * scaleMul;
        const nearBoundary = Math.random() < 0.7;
        const seed = nearBoundary
          ? (pickContourSeed(contourBand) ?? pickInteriorSeed())
          : pickInteriorSeed();
        if (place(w.word, fs, palette.dark, 3, bodyFont, 600, seed, nearBoundary))
          cyclePlacements++;
      }
      for (const w of unplacedSmall.slice(0, 40)) {
        const fs = shapeH * (etsy ? 0.0087 : 0.0094);
        const nearBoundary = Math.random() < 0.6;
        const seed = nearBoundary
          ? (pickContourSeed(contourBand) ?? pickInteriorSeed())
          : pickInteriorSeed();
        if (place(w.word, fs, palette.mid, 4, bodyFont, 400, seed, nearBoundary)) cyclePlacements++;
      }

      // 2) Fill remaining micro gaps from empty cells with adaptive tiny words.
      const microPlacementsPerCycle = etsy ? 120 : 80;
      for (let m = 0; m < microPlacementsPerCycle; m++) {
        const w = pool[i % pool.length];
        const key = w.word.toLowerCase();
        i++;
        if ((wordCounts.get(key) ?? 0) >= perWordCap) continue;

        const shrink = 1 - Math.min(0.62, coverageNow * 0.55);
        const baseFs = Math.max(MIN_FONT_PT, startFs * shrink);
        const sizes = [baseFs, baseFs * 0.8, baseFs * 0.65, MIN_FONT_PT];
        let placedMicro = false;
        for (const fs of sizes) {
          if (fs < MIN_FONT_PT - 0.5) continue;
          const nearBoundary = Math.random() < 0.5;
          const seed = nearBoundary
            ? (pickContourSeed(contourBand) ?? pickInteriorSeed() ?? pickEmptySeed())
            : (pickInteriorSeed() ?? pickEmptySeed());
          if (place(w.word, fs, palette.light, 5, bodyFont, 400, seed, nearBoundary)) {
            placedMicro = true;
            break;
          }
        }
        if (placedMicro) cyclePlacements++;
      }

      // 3) Rebalance composition across lighter regions.
      const preferLeft = rightWeight > leftWeight;
      const preferTop = bottomWeight > topWeight;
      const prioritizedRegions = [
        ...sparseRegions.map((entry) => entry.region),
        ...(preferTop ? (["head", "leftArm", "rightArm"] as RegionKey[]) : []),
        ...(preferLeft ? (["leftArm", "leftLeg"] as RegionKey[]) : ["rightArm", "rightLeg"]),
        "torso",
        "leftArm",
        "rightArm",
        "head",
        "leftLeg",
        "rightLeg",
      ].filter((region, index, arr) => arr.indexOf(region) === index);
      const balancingWords = pool.slice(0, 40);
      for (let b = 0; b < balancingWords.length; b++) {
        const region = prioritizedRegions[b % prioritizedRegions.length] ?? "torso";
        const seed = pickRegionSeed(region) ?? pickEmptySeed();
        const fs = shapeH * 0.008;
        if (place(balancingWords[b].word, fs, palette.light, 5, bodyFont, 400, seed, false)) {
          cyclePlacements++;
        }
      }

      // 4) Floor enforcement: keep filling until at least occupancyMin.
      if (pool.length > 0 && maskCellCount > 0) {
        let guard = 0;
        while (occupiedCount / maskCellCount < occupancyMin && guard < 1200) {
          const w = pool[guard % pool.length];
          const fs = Math.max(MIN_FONT_PT, shapeH * 0.0065);
          const seed = pickInteriorSeed() ?? pickEmptySeed();
          if (place(w.word, fs, palette.light, 5, bodyFont, 400, seed, false)) cyclePlacements++;
          guard++;
        }
      }

      cycle++;
      if (cyclePlacements === 0) break;
      if (cycle % 2 === 0) {
        completedUnits = Math.min(totalUnits - 1, completedUnits + 1);
        sendProgress();
      }
    }
  }

  // Real silhouette area coverage (filled mask cells / total mask cells).
  const coverage = maskCellCount === 0 ? 0 : occupiedCount / maskCellCount;
  const uniqueCount = uniqueWordsSeen.size;
  const duplicateCount = Math.max(0, placedTotal - uniqueCount);
  const diversityScore = placedTotal === 0 ? 0 : (uniqueCount / placedTotal) * 100;
  const totalWeight = leftWeight + rightWeight + topWeight + bottomWeight || 1;
  const lrDelta = Math.abs(leftWeight - rightWeight) / (leftWeight + rightWeight || 1);
  const tbDelta = Math.abs(topWeight - bottomWeight) / (topWeight + bottomWeight || 1);
  const balanceScore = Math.max(0, 100 - ((lrDelta + tbDelta) / 2) * 140);
  const nameAreaPct = nameText
    ? (((measureWord(nameText, nameSize, nameFont, 800) + 12) * (nameSize + 8)) /
        (width * height)) *
      100
    : 0;
  const accentRatio = (accentPlacements / Math.max(1, placedTotal)) * 100;
  const totalOriented = horizontalPlacements + verticalPlacements;
  const horizontalRatio = totalOriented === 0 ? 1 : horizontalPlacements / totalOriented;
  const verticalRatio = totalOriented === 0 ? 0 : verticalPlacements / totalOriented;
  const dominantNameScore = nameArea / Math.max(1, maxNonNameArea);

  let inter = 0;
  let union = 0;
  const widthMask = new Array<number>(OG).fill(0);
  const widthOcc = new Array<number>(OG).fill(0);
  const heightMask = new Array<number>(OG).fill(0);
  const heightOcc = new Array<number>(OG).fill(0);
  for (let y = 0; y < OG; y++) {
    for (let x = 0; x < OG; x++) {
      const i = y * OG + x;
      if (inMask[i] === 1) {
        widthMask[y]++;
        heightMask[x]++;
      }
      if (occupied[i] === 1) {
        widthOcc[y]++;
        heightOcc[x]++;
      }
      if (inMask[i] === 1 || occupied[i] === 1) union++;
      if (inMask[i] === 1 && occupied[i] === 1) inter++;
    }
  }
  const widthProfileScore = scoreProfileSimilarity(
    widthMask.map((v) => v / OG),
    widthOcc.map((v) => v / OG),
  );
  const heightProfileScore = scoreProfileSimilarity(
    heightMask.map((v) => v / OG),
    heightOcc.map((v) => v / OG),
  );

  const maskDistanceField = buildSignedDistanceField(inMask, OG);
  const occDistanceField = buildSignedDistanceField(occupied, OG);
  let edgeInter = 0;
  let edgeUnion = 0;
  for (let i = 0; i < maskDistanceField.contourPixels.length; i++) {
    if (maskDistanceField.contourPixels[i] === 1 || occDistanceField.contourPixels[i] === 1) {
      edgeUnion++;
    }
    if (maskDistanceField.contourPixels[i] === 1 && occDistanceField.contourPixels[i] === 1) {
      edgeInter++;
    }
  }
  const contourProfileScore = edgeUnion === 0 ? 0 : edgeInter / edgeUnion;
  const regionCoverage = computeRegionCoverage();
  const regionTarget = Math.max(0.28, occupancyMin * 0.42);
  const regionScores = regionCoverage.map((entry) => clamp(entry.ratio / regionTarget, 0, 1));
  const weakestRegionScore = regionScores.length > 0 ? Math.min(...regionScores) : 1;
  const averageRegionScore =
    regionScores.length > 0
      ? regionScores.reduce((sum, score) => sum + score, 0) / regionScores.length
      : 1;
  const globalCoverageScore =
    coverage >= occupancyMin && coverage <= occupancyTarget
      ? 1
      : coverage > occupancyTarget && coverage <= occupancyMax
        ? clamp(
            1 - (coverage - occupancyTarget) / Math.max(0.0001, occupancyMax - occupancyTarget),
            0,
            1,
          )
        : clamp(coverage / occupancyMin, 0, 1);
  const regionOccupancyScore = clamp(
    averageRegionScore * 0.6 + weakestRegionScore * 0.25 + globalCoverageScore * 0.15,
    0,
    1,
  );
  const iou = union === 0 ? 0 : inter / union;
  const silhouetteSimilarity = clamp(
    iou * 0.35 +
      widthProfileScore * 0.2 +
      heightProfileScore * 0.2 +
      contourProfileScore * 0.15 +
      regionOccupancyScore * 0.1,
    0,
    1,
  );
  const qualityPassed =
    silhouetteSimilarity >= silhouetteMin &&
    widthProfileScore >= 0.78 &&
    heightProfileScore >= 0.78 &&
    contourProfileScore >= 0.72 &&
    coverage >= occupancyMin &&
    coverage <= occupancyMax &&
    dominantNameScore >= 1.0;

  const result: PackResult = {
    placedCount: placedTotal,
    uniqueCount,
    duplicateCount,
    diversityScore,
    coverage,
    nameAreaPct,
    accentRatio,
    balanceScore: totalWeight ? balanceScore : 0,
    widthProfileScore,
    heightProfileScore,
    contourProfileScore,
    regionOccupancyScore,
    silhouetteSimilarity,
    horizontalRatio,
    verticalRatio,
    dominantNameScore,
    qualityPassed,
  };

  sendProgress(true);
  return { placements, result };
}

self.onmessage = (event: MessageEvent<WordPackerWorkerRequest>) => {
  const { data } = event;
  if (data.type !== "pack") return;

  try {
    const output = computePlacements(data.payload.mask, data.payload.maskSize, data.payload.opts);
    const message: WordPackerWorkerResponse = { type: "complete", payload: output };
    self.postMessage(message);
  } catch (error) {
    const message: WordPackerWorkerResponse = {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(message);
  }
};
