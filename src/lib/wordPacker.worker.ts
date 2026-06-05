import type {
  PackComputationResult,
  PackOptions,
  PackPlacement,
  PackResult,
  WordPackerWorkerRequest,
  WordPackerWorkerResponse,
} from "./wordPacker";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
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
    [x0, y0], [x1, y0], [x0, y1], [x1, y1],
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
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(a: string, b: string, t: number): string {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return a;
  return rgbToHex(ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t);
}
function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}
function colorsClose(a: string, b: string, tol = 0.08): boolean {
  return Math.abs(luminance(a) - luminance(b)) < tol;
}

function buildPalette(opts: PackOptions): { dark: string; mid: string; light: string; accent: string } {
  const primary = opts.primaryColor ?? "#000000";
  const accent = opts.accentColor;
  const bg = opts.bgColor ?? "#FFFFFF";
  const src = (opts.palette && opts.palette.length > 0 ? opts.palette : [primary, accent, mix(primary, bg, 0.55)])
    .filter((c) => hexToRgb(c));
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
  const { width, height } = opts;

  // --- Mask bounding box (in canvas pixel space) ---
  // Font sizes & search seeding scale to the SILHOUETTE, not the canvas, so a
  // small mask inside a large canvas still gets correctly-sized words.
  let mnX = maskSize, mnY = maskSize, mxX = -1, mxY = -1;
  for (let y = 0; y < maskSize; y++) {
    const row = y * maskSize;
    for (let x = 0; x < maskSize; x++) {
      if (mask[row + x] === 1) {
        if (x < mnX) mnX = x;
        if (x > mxX) mxX = x;
        if (y < mnY) mnY = y;
        if (y > mxY) mxY = y;
      }
    }
  }
  if (mxX < 0) { mnX = 0; mnY = 0; mxX = maskSize - 1; mxY = maskSize - 1; }
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
      if (mask[myi * maskSize + mxi] === 1) {
        inMask[y * OG + x] = 1;
        maskCellCount++;
      }
    }
  }
  const occupied = new Uint8Array(OG * OG);
  let occupiedCount = 0;

  const isEmptyCell = (i: number) => inMask[i] === 1 && occupied[i] === 0;

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
      if (isEmptyCell(i)) {
        return {
          x: ((i % OG) + 0.5) * cellW,
          y: (Math.floor(i / OG) + 0.5) * cellH,
        };
      }
    }
    return null;
  }

  // Pick seed weighted toward the largest empty region (for big words).
  function pickLargestEmptySeed(samples = 50): { x: number; y: number } | null {
    let best: { x: number; y: number; score: number } | null = null;
    const R = 6;
    for (let t = 0; t < samples; t++) {
      const i = Math.floor(Math.random() * OG * OG);
      if (!isEmptyCell(i)) continue;
      const cx = i % OG;
      const cy = Math.floor(i / OG);
      let score = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= OG) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= OG) continue;
          if (isEmptyCell(yy * OG + xx)) score++;
        }
      }
      if (!best || score > best.score) {
        best = { x: (cx + 0.5) * cellW, y: (cy + 0.5) * cellH, score };
      }
    }
    return best;
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

  const sendProgress = (force = false) => {
    const progress = force ? 100 : Math.min(99, Math.round((completedUnits / totalUnits) * 100));
    if (force || progress > lastProgress) {
      const message: WordPackerWorkerResponse = { type: "progress", progress };
      self.postMessage(message);
      lastProgress = progress;
    }
  };

  function trackPlacement(word: string, box: Box, color: string) {
    const key = word.toLowerCase();
    wordCounts.set(key, (wordCounts.get(key) ?? 0) + 1);
    uniqueWordsSeen.add(key);
    if (color === palette.accent) accentPlacements++;
    const area = box.w * box.h;
    const midX = box.x + box.w / 2;
    const midY = box.y + box.h / 2;
    if (midX < cx) leftWeight += area;
    else rightWeight += area;
    if (midY < cy) topWeight += area;
    else bottomWeight += area;
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
  ): boolean {
    const allowRotate = tier >= 3;
    const angle = allowRotate && Math.random() < 0.2 ? Math.PI / 2 : 0;
    const tw = measureWord(word, fontSize, fontFamily, fontWeight);
    const th = fontSize * 1.05;
    const bw = angle ? th : tw;
    const bh = angle ? tw : th;

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

      if (!boxInsideMask(mask, maskSize, box, width, height, pad)) {
        theta += GOLDEN_ANGLE;
        r += step * 0.05;
        continue;
      }

      if (!grid.collides(box)) {
        grid.add(box);
        placements.push({ x, y, word, fontSize, color, angle, fontFamily, fontWeight });
        trackPlacement(word, box, color);
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
  function placeWithSeeds(
    word: string,
    fontSize: number,
    color: string,
    tier: 2 | 3 | 4 | 5,
    fontFamily: string,
    fontWeight: number,
    seedAttempts = 4,
    preferLarge = false,
  ): boolean {
    for (let s = 0; s < seedAttempts; s++) {
      const seed = preferLarge && s === 0
        ? pickLargestEmptySeed()
        : pickEmptySeed();
      if (place(word, fontSize, color, tier, fontFamily, fontWeight, seed)) return true;
    }
    // Final fallback: center spiral.
    return place(word, fontSize, color, tier, fontFamily, fontWeight, null);
  }

  // --- Tier 1: name, locked to center, registered FIRST ---
  const nameText = (opts.name || "").trim();
  // Reference-art sizing: ~10% of SILHOUETTE height, with small emphasis nudge.
  const targetNameSize =
    shapeH *
    ((etsy ? 0.085 : 0.10) + 0.01 * Math.min(1, Math.max(-1, emphasisMul - 1))) *
    scaleMul;
  const maxNameWidth = bboxW * 0.55;
  let nameSize = targetNameSize;
  if (nameText) {
    let measured = measureWord(nameText, nameSize, nameFont, 800);
    if (measured > maxNameWidth) nameSize = nameSize * (maxNameWidth / measured);
    const minNameSize = Math.max(18, shapeH * 0.05);
    if (nameSize < minNameSize) nameSize = minNameSize;
    measured = measureWord(nameText, nameSize, nameFont, 800);
    const nameBox: Box = {
      x: cx - measured / 2 - 6,
      y: cy - nameSize / 2 - 4,
      w: measured + 12,
      h: nameSize + 8,
    };
    grid.add(nameBox);
    markBoxOcc(nameBox);
    const nameColor = palette.dark;
    placements.push({
      word: nameText,
      x: cx,
      y: cy,
      fontSize: nameSize,
      color: nameColor,
      angle: 0,
      fontFamily: nameFont,
      fontWeight: 800,
    });
    trackPlacement(nameText, nameBox, nameColor);
    placedTotal++;
    placedInsideMask++;
  }
  completedUnits++;
  sendProgress();

  // --- Tier 2: large, dark, horizontal-only. Seed in largest empty region. ---
  for (const w of tier2) {
    const fs = shapeH * (etsy ? 0.034 : 0.042 + Math.random() * 0.008) * scaleMul * emphasisMul;
    const color = Math.random() < 0.25 ? palette.accent : palette.dark;
    placeWithSeeds(w.word, fs, color, 2, bodyFont, 700, 5, true);
    completedUnits++;
    sendProgress();
  }

  

  // --- Tier 3: medium ---
  for (const w of tier3) {
    const fs = shapeH * (etsy ? 0.015 : 0.017) * scaleMul;
    const color = Math.random() < 0.5 ? palette.dark : palette.mid;
    placeWithSeeds(w.word, fs, color, 3, bodyFont, 500, 4, false);
    completedUnits++;
    sendProgress();
  }

  // --- Tier 4: small ---
  for (const w of tier4) {
    const fs = shapeH * (etsy ? 0.0095 : 0.0105) + (Math.random() - 0.5) * 1.2;
    const color = Math.random() < 0.2 ? palette.accent : palette.mid;
    placeWithSeeds(w.word, fs, color, 4, bodyFont, 400, 3, false);
    completedUnits++;
    sendProgress();
  }

  // --- Tier 5: coverage-driven micro-fill mortar ---
  // Keep placing micro words until area coverage reaches ~95% OR we plateau.
  if (pool.length > 0) {
    const MIN_FONT_PT = Math.max(3, shapeMin * 0.0028);
    const startFs = Math.max(MIN_FONT_PT, shapeH * (etsy ? 0.0085 : 0.0095));
    const HARD_CAP = etsy ? 6000 : 12000;
    const MAX_CONSEC_FAIL = 600;
    const perWordCap = 4;
    const COVERAGE_FLOOR = 0.88;
    const COVERAGE_TARGET = 0.92;
    const COVERAGE_MAX = 0.95;
    let consecFail = 0;
    let i = 0;
    while (i < HARD_CAP) {
      const coverageNow = maskCellCount === 0 ? 1 : occupiedCount / maskCellCount;
      if (coverageNow >= COVERAGE_MAX) break;
      if (coverageNow >= COVERAGE_TARGET) break;
      // Below floor: keep pushing even past plateau (reset budget once).
      if (consecFail >= MAX_CONSEC_FAIL) {
        if (coverageNow < COVERAGE_FLOOR) consecFail = 0;
        else break;
      }

      const w = pool[i % pool.length];
      const key = w.word.toLowerCase();
      if ((wordCounts.get(key) ?? 0) >= perWordCap) {
        i++;
        continue;
      }
      // Adaptive shrink — get smaller as coverage climbs, so we squeeze into gaps.
      const shrink = 1 - Math.min(0.6, coverageNow * 0.5);
      const baseFs = Math.max(MIN_FONT_PT, startFs * shrink);
      const sizes = [baseFs, baseFs * 0.8, baseFs * 0.6, MIN_FONT_PT];
      let placed = false;
      for (const fs of sizes) {
        if (fs < MIN_FONT_PT - 0.5) continue;
        // Always seed from an empty cell — true gap-filling.
        if (placeWithSeeds(w.word, fs, palette.light, 5, bodyFont, 400, 3, false)) {
          placed = true;
          break;
        }
      }
      if (placed) consecFail = 0;
      else consecFail++;
      i++;
      if (i % 20 === 0) {
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
    ? ((measureWord(nameText, nameSize, nameFont, 800) + 12) * (nameSize + 8) /
        (width * height)) *
      100
    : 0;
  const accentRatio = (accentPlacements / Math.max(1, placedTotal)) * 100;

  const result: PackResult = {
    placedCount: placedTotal,
    uniqueCount,
    duplicateCount,
    diversityScore,
    coverage,
    nameAreaPct,
    accentRatio,
    balanceScore: totalWeight ? balanceScore : 0,
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
