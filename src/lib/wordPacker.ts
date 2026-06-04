import type { WordEntry } from "./gemini";

export interface PackOptions {
  width: number;
  height: number;
  name: string;
  words: WordEntry[];
  fontFamily: string;
  accentColor: string;
  primaryColor?: string;
  bgColor?: string;
  density: number; // 10-100
  scaling: number; // 10-50
  adherence: number; // 10-100
  rotation: number; // 0-100
  randomness: number; // 0-100
  centerBias: number; // 0-100
  emphasis: number; // 1-5
}

export interface PackResult {
  placedCount: number;
  uniqueCount: number;
  coverage: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Build alpha mask from an SVG string. Returns 0/1 array sized maskSize x maskSize.
export async function buildMaskFromSvg(svg: string, maskSize = 512): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = maskSize;
      c.height = maskSize;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, maskSize, maskSize);
      ctx.drawImage(img, 0, 0, maskSize, maskSize);
      const data = ctx.getImageData(0, 0, maskSize, maskSize).data;
      const out = new Uint8Array(maskSize * maskSize);
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        // Black pixel = part of shape
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        out[j] = lum < 128 ? 1 : 0;
      }
      URL.revokeObjectURL(url);
      resolve(out);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function maskAt(mask: Uint8Array, maskSize: number, nx: number, ny: number): boolean {
  // nx, ny in 0..1
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return false;
  const mx = Math.min(maskSize - 1, Math.floor(nx * maskSize));
  const my = Math.min(maskSize - 1, Math.floor(ny * maskSize));
  return mask[my * maskSize + mx] === 1;
}

function rectsOverlap(a: Box, b: Box): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

// Grid-based spatial index for fast collision
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
        if (arr) arr.push(b); else this.cells.set(k, [b]);
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

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export async function packWords(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  maskSize: number,
  opts: PackOptions,
): Promise<PackResult> {
  const { width, height } = opts;
  ctx.fillStyle = opts.bgColor ?? "#FFFFFF";
  ctx.fillRect(0, 0, width, height);

  const primary = opts.primaryColor ?? "#000000";
  const accent = opts.accentColor;
  const grid = new Grid(Math.max(20, Math.min(width, height) / 40));

  const scaleMul = 1 + (opts.scaling - 10) / 40; // 1..2
  const emphasisMul = 0.8 + opts.emphasis * 0.1; // 0.9..1.3
  const rotChance = opts.rotation / 100;
  const randomness = opts.randomness / 100;
  const adherence = opts.adherence / 100;

  const cx = width / 2;
  const cy = height / 2;

  // sort words by importance desc
  const sorted = [...opts.words].sort((a, b) => b.importanceScore - a.importanceScore);

  // ensure name present
  const nameEntry = sorted.find((w) => w.word.toLowerCase() === opts.name.toLowerCase());
  if (!nameEntry) sorted.unshift({ word: opts.name, category: "Name", importanceScore: 1000 });

  const uniqueWordsSeen = new Set<string>();
  let placedInsideMask = 0;
  let placedTotal = 0;

  function place(word: string, fontSize: number, color: string, allowRotate: boolean, mustBeInMask: boolean): boolean {
    const angles = allowRotate && Math.random() < rotChance ? [Math.PI / 2] : [0];
    const angle = angles[0];
    ctx.font = `${fontSize}px "${opts.fontFamily}", sans-serif`;
    const metrics = ctx.measureText(word);
    const tw = metrics.width;
    const th = fontSize * 1.05;
    // box dims considering rotation
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

      // bounds check
      if (box.x < 4 || box.y < 4 || box.x + box.w > width - 4 || box.y + box.h > height - 4) {
        theta += GOLDEN_ANGLE;
        r += step * 0.1;
        continue;
      }

      const insideMask =
        maskAt(mask, maskSize, (x) / width, (y) / height) &&
        maskAt(mask, maskSize, box.x / width, box.y / height) &&
        maskAt(mask, maskSize, (box.x + box.w) / width, (box.y + box.h) / height);

      if (mustBeInMask && !insideMask) {
        theta += GOLDEN_ANGLE;
        r += step * 0.05;
        continue;
      }

      if (!grid.collides(box)) {
        grid.add(box);
        ctx.save();
        ctx.translate(x, y);
        if (angle) ctx.rotate(angle);
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(word, 0, 0);
        ctx.restore();
        uniqueWordsSeen.add(word.toLowerCase());
        placedTotal++;
        if (insideMask) placedInsideMask++;
        return true;
      }

      theta += GOLDEN_ANGLE;
      r += step * 0.05;
      // perturb r occasionally
      if (i % 50 === 0) r += step;
      if (r > maxR) r = startR + Math.random() * 20;
    }
    return false;
  }

  // Tier 1: name at center
  const nameSize = height * (0.14 + 0.04 * Math.min(1, emphasisMul - 0.9)) * scaleMul * 0.8;
  ctx.font = `bold ${nameSize}px "${opts.fontFamily}", sans-serif`;
  const nm = ctx.measureText(opts.name);
  const nameBox: Box = {
    x: cx - nm.width / 2 - 10,
    y: cy - nameSize / 2 - 6,
    w: nm.width + 20,
    h: nameSize + 12,
  };
  grid.add(nameBox);
  ctx.save();
  ctx.fillStyle = accent;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(opts.name, cx, cy);
  ctx.restore();
  uniqueWordsSeen.add(opts.name.toLowerCase());
  placedTotal++;
  placedInsideMask++;

  // Filter out name from rest
  const rest = sorted.filter((w) => w.word.toLowerCase() !== opts.name.toLowerCase());

  // Tier 2: primary 85-100
  const tier2 = rest.filter((w) => w.importanceScore >= 85).slice(0, 8);
  for (const w of tier2) {
    const fs = height * (0.04 + Math.random() * 0.02) * scaleMul * emphasisMul;
    const color = Math.random() < 0.3 ? accent : primary;
    place(w.word, fs, color, false, true);
  }

  // Tier 3: supporting 40-84
  const tier3 = rest.filter((w) => w.importanceScore >= 40 && w.importanceScore < 85).slice(0, 80);
  const densityMul = opts.density / 100;
  for (const w of tier3) {
    if (Math.random() > densityMul) continue;
    const fs = height * 0.022 * scaleMul;
    const color = Math.random() < 0.15 ? accent : primary;
    place(w.word, fs, color, true, Math.random() < adherence);
  }

  // Tier 4: filler 10-39
  const tier4 = rest.filter((w) => w.importanceScore >= 10 && w.importanceScore < 40).slice(0, 200);
  for (const w of tier4) {
    if (Math.random() > densityMul) continue;
    const fs = (height * 0.013) + (Math.random() - 0.5) * 2;
    const color = Math.random() < 0.12 ? accent : primary;
    place(w.word, fs, color, true, Math.random() < adherence);
  }

  // Tier 5: micro fill, repeat lower-scored words
  const pool = rest.filter((w) => w.importanceScore < 50);
  if (pool.length > 0) {
    for (let i = 0; i < 400; i++) {
      const w = pool[i % pool.length];
      const fs = height * 0.008;
      const color = Math.random() < 0.1 ? accent : primary;
      const ok = place(w.word, fs, color, true, Math.random() < adherence);
      if (!ok && i > 100) break;
    }
  }

  const coverage = placedTotal === 0 ? 0 : placedInsideMask / placedTotal;
  return { placedCount: placedTotal, uniqueCount: uniqueWordsSeen.size, coverage };
}
