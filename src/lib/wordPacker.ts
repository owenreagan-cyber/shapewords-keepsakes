import type { WordEntry } from "./gemini";

export interface PackOptions {
  width: number;
  height: number;
  name: string;
  words: WordEntry[];
  fontFamily: string;
  bodyFontFamily?: string;
  nameFontFamily?: string;
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

async function runWordPackerWorker(
  mask: Uint8Array,
  maskSize: number,
  opts: PackOptions,
  onProgress?: (progress: number) => void,
): Promise<PackComputationResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./wordPacker.worker.ts", import.meta.url), {
      type: "module",
    });

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<WordPackerWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.progress);
        return;
      }
      if (message.type === "complete") {
        cleanup();
        resolve(message.payload);
        return;
      }
      cleanup();
      reject(new Error(message.error));
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Word packing worker failed"));
    };

    const request: WordPackerWorkerRequest = { type: "pack", payload: { mask, maskSize, opts } };
    worker.postMessage(request);
  });
}

function drawPlacements(
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

export async function packWords(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  maskSize: number,
  opts: PackOptions,
  onProgress?: (progress: number) => void,
): Promise<PackResult> {
  onProgress?.(0);
  const packed = await runWordPackerWorker(mask, maskSize, opts, onProgress);
  drawPlacements(ctx, opts.width, opts.height, opts.bgColor ?? "#FFFFFF", packed.placements);
  onProgress?.(100);
  return packed.result;
}
