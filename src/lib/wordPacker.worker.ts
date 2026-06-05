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

// Dense containment test: sample interior + perimeter points. ALL must be inside.
function boxInsideMask(
  mask: Uint8Array,
  maskSize: number,
  box: Box,
  width: number,
  height: number,
  inset: number,
): boolean {
  const ix = box.w * inset;
  const iy = box.h * inset;
  const x0 = box.x + ix;
  const y0 = box.y + iy;
  const w = box.w - 2 * ix;
  const h = box.h - 2 * iy;
  if (w <= 0 || h <= 0) return false;
  // 5x3 grid of sample points covering the glyph bbox.
  const cols = 5;
  const rows = 3;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const px = x0 + (w * c) / cols;
      const py = y0 + (h * r) / rows;
      if (!maskAt(mask, maskSize, px / width, py / height)) return false;
    }
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
  const ctx = new OffscreenCanvas(1, 1).getContext("2d");
  return ctx;
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

function computePlacements(
  mask: Uint8Array,
  maskSize: number,
  opts: PackOptions,
): PackComputationResult {
  const { width, height } = opts;
  const primary = opts.primaryColor ?? "#000000";
  const accent = opts.accentColor;
  const bodyFont = opts.bodyFontFamily ?? opts.fontFamily;
  const nameFont = opts.nameFontFamily ?? opts.fontFamily;
  const grid = new Grid(Math.max(20, Math.min(width, height) / 40));

  const etsy = !!opts.etsyMode;
  const scaleMul = 1 + (opts.scaling - 10) / 40;
  const emphasisMul = 0.8 + opts.emphasis * 0.1;
  const rotChance = (opts.rotation / 100) * (etsy ? 0.2 : 1);
  const randomness = (opts.randomness / 100) * (etsy ? 0.6 : 1);
  const adherence = opts.adherence / 100;

  const cx = width / 2;
  const cy = height / 2;

  const sorted = [...opts.words].sort((a, b) => b.importanceScore - a.importanceScore);
  const nameEntry = sorted.find((w) => w.word.toLowerCase() === opts.name.toLowerCase());
  if (!nameEntry) sorted.unshift({ word: opts.name, category: "Name", importanceScore: 1000 });

  const rest = sorted.filter((w) => w.word.toLowerCase() !== opts.name.toLowerCase());
  const tier2 = rest.filter((w) => w.importanceScore >= 85).slice(0, etsy ? 6 : 8);
  const tier3 = rest
    .filter((w) => w.importanceScore >= 40 && w.importanceScore < 85)
    .slice(0, etsy ? 55 : 80);
  const tier4 = rest
    .filter((w) => w.importanceScore >= 10 && w.importanceScore < 40)
    .slice(0, etsy ? 140 : 200);
  const pool = rest.filter((w) => w.importanceScore < 50);
  const tier5Cap = pool.length > 0 ? (etsy ? 180 : 400) : 0;

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
    if (color === accent) accentPlacements++;
    const area = box.w * box.h;
    const midX = box.x + box.w / 2;
    const midY = box.y + box.h / 2;
    if (midX < cx) leftWeight += area;
    else rightWeight += area;
    if (midY < cy) topWeight += area;
    else bottomWeight += area;
  }

  function place(
    word: string,
    fontSize: number,
    color: string,
    allowRotate: boolean,
    mustBeInMask: boolean,
    fontFamily: string,
    fontWeight: number,
  ): boolean {
    const angle = allowRotate && Math.random() < rotChance ? Math.PI / 2 : 0;
    const tw = measureWord(word, fontSize, fontFamily, fontWeight);
    const th = fontSize * 1.05;
    const bw = angle ? th : tw;
    const bh = angle ? tw : th;

    const startR = Math.min(width, height) * (1 - opts.centerBias / 100) * 0.1;
    const maxR = Math.max(width, height);
    const step = Math.max(2, fontSize * 0.15 * (1 + randomness));
    const maxAttempts = 2000;
    let r = startR;
    let theta = Math.random() * Math.PI * 2;

    for (let i = 0; i < maxAttempts; i++) {
      const x = cx + Math.cos(theta) * r;
      const y = cy + Math.sin(theta) * r;
      const box: Box = { x: x - bw / 2, y: y - bh / 2, w: bw, h: bh };

      if (box.x < 4 || box.y < 4 || box.x + box.w > width - 4 || box.y + box.h > height - 4) {
        theta += GOLDEN_ANGLE;
        r += step * 0.1;
        continue;
      }

      const insideMask =
        maskAt(mask, maskSize, x / width, y / height) &&
        maskAt(mask, maskSize, box.x / width, box.y / height) &&
        maskAt(mask, maskSize, (box.x + box.w) / width, (box.y + box.h) / height);

      if (mustBeInMask && !insideMask) {
        theta += GOLDEN_ANGLE;
        r += step * 0.05;
        continue;
      }

      if (!grid.collides(box)) {
        grid.add(box);
        const placement: PackPlacement = {
          x,
          y,
          word,
          fontSize,
          color,
          angle,
          fontFamily,
          fontWeight,
        };
        placements.push(placement);
        trackPlacement(word, box, color);
        placedTotal++;
        if (insideMask) placedInsideMask++;
        return true;
      }

      theta += GOLDEN_ANGLE;
      r += step * 0.05;
      if (i % 50 === 0) r += step;
      if (r > maxR) r = startR + Math.random() * 20;
    }
    return false;
  }

  // Ensure the student's name is ALWAYS rendered prominently and never clipped.
  // Start from an emphasis-driven target size, then shrink to fit the canvas width.
  const nameText = (opts.name || "").trim();
  const targetNameSize =
    height *
    (etsy ? 0.13 : 0.16 + 0.04 * Math.min(1, emphasisMul - 0.9)) *
    scaleMul;
  const maxNameWidth = width * 0.78;
  let nameSize = targetNameSize;
  if (nameText) {
    let measured = measureWord(nameText, nameSize, nameFont, 800);
    if (measured > maxNameWidth) {
      nameSize = nameSize * (maxNameWidth / measured);
    }
    // Enforce a visible minimum so the name never disappears on long names / narrow shapes
    const minNameSize = Math.max(28, height * 0.06);
    if (nameSize < minNameSize) nameSize = minNameSize;
    measured = measureWord(nameText, nameSize, nameFont, 800);
    const nameBox: Box = {
      x: cx - measured / 2 - 10,
      y: cy - nameSize / 2 - 6,
      w: measured + 20,
      h: nameSize + 12,
    };
    grid.add(nameBox);
    // Guarantee accent never matches the background (otherwise the name would be invisible)
    const bg = (opts.bgColor ?? "#FFFFFF").toLowerCase();
    const nameColor = accent.toLowerCase() === bg ? primary : accent;
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
  }
  placedTotal++;
  placedInsideMask++;
  completedUnits++;
  sendProgress();

  for (const w of tier2) {
    const fs = height * (etsy ? 0.032 : 0.04 + Math.random() * 0.02) * scaleMul * emphasisMul;
    const color = Math.random() < (etsy ? 0.24 : 0.3) ? accent : primary;
    place(w.word, fs, color, false, true, bodyFont, 400);
    completedUnits++;
    sendProgress();
  }

  const densityMul = (opts.density / 100) * (etsy ? 0.82 : 1);
  for (const w of tier3) {
    if (Math.random() <= densityMul) {
      const fs = height * (etsy ? 0.019 : 0.022) * scaleMul;
      const color = Math.random() < (etsy ? 0.11 : 0.15) ? accent : primary;
      place(w.word, fs, color, !etsy, Math.random() < adherence, bodyFont, 400);
    }
    completedUnits++;
    sendProgress();
  }

  for (const w of tier4) {
    if (Math.random() <= densityMul) {
      const fs = height * (etsy ? 0.011 : 0.013) + (Math.random() - 0.5) * 2;
      const color = Math.random() < (etsy ? 0.08 : 0.12) ? accent : primary;
      place(w.word, fs, color, !etsy, Math.random() < adherence, bodyFont, 400);
    }
    completedUnits++;
    sendProgress();
  }

  if (pool.length > 0) {
    for (let i = 0; i < tier5Cap; i++) {
      const w = pool[i % pool.length];
      const fs = height * (etsy ? 0.007 : 0.008);
      const color = Math.random() < (etsy ? 0.06 : 0.1) ? accent : primary;
      const ok = place(w.word, fs, color, !etsy, Math.random() < adherence, bodyFont, 400);
      completedUnits++;
      sendProgress();
      if (!ok && i > 100) break;
    }
  }

  const coverage = placedTotal === 0 ? 0 : placedInsideMask / placedTotal;
  const uniqueCount = uniqueWordsSeen.size;
  const duplicateCount = Math.max(0, placedTotal - uniqueCount);
  const diversityScore = placedTotal === 0 ? 0 : (uniqueCount / placedTotal) * 100;
  const totalWeight = leftWeight + rightWeight + topWeight + bottomWeight || 1;
  const lrDelta = Math.abs(leftWeight - rightWeight) / (leftWeight + rightWeight || 1);
  const tbDelta = Math.abs(topWeight - bottomWeight) / (topWeight + bottomWeight || 1);
  const balanceScore = Math.max(0, 100 - ((lrDelta + tbDelta) / 2) * 140);
  const nameAreaPct = nameText
    ? ((measureWord(nameText, nameSize, nameFont, 800) + 20) * (nameSize + 12) /
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
