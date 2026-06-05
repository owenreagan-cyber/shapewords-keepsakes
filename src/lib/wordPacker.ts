import type { WordEntry } from "./gemini";

export interface PackOptions {
  width: number;
  height: number;
  name: string;
  words: WordEntry[];
  theme?: string;
  fontFamily: string;
  bodyFontFamily?: string;
  nameFontFamily?: string;
  accentColor: string;
  primaryColor?: string;
  bgColor?: string;
  palette?: string[]; // ordered dark → light, used for tier-based color mapping
  density: number; // 10-100
  scaling: number; // 10-50
  adherence: number; // 10-100
  rotation: number; // 0-100
  randomness: number; // 0-100
  centerBias: number; // 0-100
  emphasis: number; // 1-5
  etsyMode?: boolean;
}

export interface PackResult {
  placedCount: number;
  uniqueCount: number;
  duplicateCount: number;
  diversityScore: number;
  coverage: number;
  nameAreaPct: number;
  accentRatio: number;
  balanceScore: number;
}

export interface PackPlacement {
  word: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  angle: number;
  fontFamily: string;
  fontWeight: number;
}

export interface PackComputationResult {
  placements: PackPlacement[];
  result: PackResult;
}

interface WordPackerWorkerPayload {
  mask: Uint8Array;
  maskSize: number;
  opts: PackOptions;
}

export type WordPackerWorkerRequest = {
  type: "pack";
  payload: WordPackerWorkerPayload;
};

export type WordPackerWorkerResponse =
  | { type: "progress"; progress: number }
  | { type: "complete"; payload: PackComputationResult }
  | { type: "error"; error: string };

export type MaskOrientation = "landscape" | "portrait";

function parseSvgLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseSvgDimensions(svg: string): { width: number; height: number } | null {
  const viewBoxMatch = svg.match(/viewBox=["']([^"']+)["']/i);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map((n) => Number.parseFloat(n));
    if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3])) {
      const width = Math.abs(parts[2]);
      const height = Math.abs(parts[3]);
      if (width > 0 && height > 0) return { width, height };
    }
  }

  const widthMatch = svg.match(/<svg[^>]*\bwidth=["']([^"']+)["']/i);
  const heightMatch = svg.match(/<svg[^>]*\bheight=["']([^"']+)["']/i);
  const width = parseSvgLength(widthMatch?.[1] ?? null);
  const height = parseSvgLength(heightMatch?.[1] ?? null);
  if (width && height) return { width, height };
  return null;
}

async function resolveSvgContent(svgOrUrl: string): Promise<string> {
  const source = svgOrUrl.trim();
  if (source.startsWith("<svg")) return source;

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to load SVG: ${response.status}`);
  }
  return response.text();
}

export async function detectMaskOrientation(svgOrUrl: string): Promise<MaskOrientation> {
  const source = svgOrUrl.trim();
  const isSvgMarkup = source.startsWith("<svg") || source.startsWith("<?xml");
  if (!isSvgMarkup) {
    // Image URL (data:/http:) — measure natural dimensions.
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () =>
        resolve(img.naturalWidth > img.naturalHeight ? "landscape" : "portrait");
      img.onerror = () => resolve("portrait");
      img.src = source;
    });
  }
  try {
    const svg = await resolveSvgContent(source);
    const dimensions = parseSvgDimensions(svg);
    if (!dimensions) return "portrait";
    return dimensions.width > dimensions.height ? "landscape" : "portrait";
  } catch {
    return "portrait";
  }
}

// Build alpha mask from an SVG string OR an image URL (data:/http:). 0/1 array maskSize x maskSize.
export async function buildMaskFromSvg(svgOrUrl: string, maskSize = 512): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const source = svgOrUrl.trim();
    const isSvgMarkup = source.startsWith("<svg") || source.startsWith("<?xml");
    let url: string;
    let revoke = false;
    if (isSvgMarkup) {
      const blob = new Blob([source], { type: "image/svg+xml" });
      url = URL.createObjectURL(blob);
      revoke = true;
    } else {
      url = source;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
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
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        out[j] = lum < 128 ? 1 : 0;
      }
      if (revoke) URL.revokeObjectURL(url);
      resolve(out);
    };
    img.onerror = (e) => {
      if (revoke) URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export function drawPlacements(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bgColor: string,
  placements: PackPlacement[],
) {
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  for (const placement of placements) {
    ctx.save();
    ctx.translate(placement.x, placement.y);
    if (placement.angle) ctx.rotate(placement.angle);
    ctx.fillStyle = placement.color;
    ctx.font = `${placement.fontWeight} ${placement.fontSize}px "${placement.fontFamily}", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(placement.word, 0, 0);
    ctx.restore();
  }
}
