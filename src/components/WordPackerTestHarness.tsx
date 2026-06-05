import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildMaskFromSvg,
  type PackOptions,
  type PackPlacement,
  type WordPackerWorkerRequest,
  type WordPackerWorkerResponse,
} from "@/lib/wordPacker";
import type { WordEntry } from "@/lib/gemini";
import { Progress } from "@/components/ui/progress";

// ─── Canvas / mask dimensions ─────────────────────────────────────────────────
const CANVAS_W = 800;
const CANVAS_H = 1000;
const MASK_SIZE = 512;
const MOCK_NAME = "Jordan";

// ─── Gymnast silhouette – bold jumping pose for stress-testing ────────────────
const GYMNAST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="500" cy="110" r="90" fill="#000000"/>
  <ellipse cx="500" cy="360" rx="140" ry="210" fill="#000000"/>
  <ellipse cx="235" cy="265" rx="190" ry="65" fill="#000000" transform="rotate(-22 235 265)"/>
  <ellipse cx="765" cy="265" rx="190" ry="65" fill="#000000" transform="rotate(22 765 265)"/>
  <ellipse cx="350" cy="635" rx="65" ry="205" fill="#000000" transform="rotate(-28 350 635)"/>
  <ellipse cx="650" cy="635" rx="65" ry="205" fill="#000000" transform="rotate(28 650 635)"/>
  <ellipse cx="205" cy="820" rx="75" ry="35" fill="#000000"/>
  <ellipse cx="795" cy="820" rx="75" ry="35" fill="#000000"/>
</svg>`;

// ─── Mock 4th-grade student profile ──────────────────────────────────────────
// Distribution: 1 name · 5 high-priority · 15 medium-priority · 50 filler
const MOCK_WORDS: WordEntry[] = [
  // Tier 1 – Name
  { word: MOCK_NAME, category: "Name", importanceScore: 1000 },
  // Tier 2 – High priority (85+)
  { word: "gymnast", category: "Athletics", importanceScore: 98 },
  { word: "flexible", category: "Athletics", importanceScore: 95 },
  { word: "graceful", category: "Character", importanceScore: 92 },
  { word: "determined", category: "Character", importanceScore: 90 },
  { word: "fearless", category: "Character", importanceScore: 87 },
  // Tiers 3 & 4 – Medium priority (50–84)
  { word: "athletic", category: "Athletics", importanceScore: 82 },
  { word: "talented", category: "Character", importanceScore: 78 },
  { word: "dedicated", category: "Character", importanceScore: 75 },
  { word: "strong", category: "Athletics", importanceScore: 72 },
  { word: "brilliant", category: "Academics", importanceScore: 70 },
  { word: "creative", category: "Creativity", importanceScore: 68 },
  { word: "focused", category: "Character", importanceScore: 65 },
  { word: "inspired", category: "Character", importanceScore: 62 },
  { word: "leader", category: "Leadership", importanceScore: 60 },
  { word: "honest", category: "Character", importanceScore: 58 },
  { word: "kind", category: "Character", importanceScore: 55 },
  { word: "caring", category: "Character", importanceScore: 53 },
  { word: "joyful", category: "Character", importanceScore: 51 },
  { word: "smart", category: "Academics", importanceScore: 50 },
  { word: "brave", category: "Character", importanceScore: 50 },
  // Tier 5 – Low-priority fillers (<50)
  { word: "agile", category: "Athletics", importanceScore: 48 },
  { word: "quick", category: "Athletics", importanceScore: 46 },
  { word: "swift", category: "Athletics", importanceScore: 44 },
  { word: "nimble", category: "Athletics", importanceScore: 42 },
  { word: "daring", category: "Character", importanceScore: 40 },
  { word: "lively", category: "Character", importanceScore: 38 },
  { word: "spirited", category: "Character", importanceScore: 36 },
  { word: "cheerful", category: "Character", importanceScore: 35 },
  { word: "happy", category: "Character", importanceScore: 34 },
  { word: "eager", category: "Character", importanceScore: 33 },
  { word: "warm", category: "Character", importanceScore: 32 },
  { word: "fun", category: "Character", importanceScore: 31 },
  { word: "bubbly", category: "Character", importanceScore: 30 },
  { word: "sunny", category: "Character", importanceScore: 29 },
  { word: "bright", category: "Academics", importanceScore: 28 },
  { word: "sharp", category: "Academics", importanceScore: 27 },
  { word: "clever", category: "Academics", importanceScore: 26 },
  { word: "witty", category: "Academics", importanceScore: 25 },
  { word: "curious", category: "Academics", importanceScore: 24 },
  { word: "diligent", category: "Academics", importanceScore: 23 },
  { word: "patient", category: "Character", importanceScore: 22 },
  { word: "gentle", category: "Character", importanceScore: 21 },
  { word: "sweet", category: "Character", importanceScore: 20 },
  { word: "thoughtful", category: "Character", importanceScore: 19 },
  { word: "helpful", category: "Friendship", importanceScore: 18 },
  { word: "giving", category: "Friendship", importanceScore: 17 },
  { word: "loyal", category: "Friendship", importanceScore: 16 },
  { word: "true", category: "Character", importanceScore: 15 },
  { word: "pure", category: "Character", importanceScore: 14 },
  { word: "noble", category: "Character", importanceScore: 13 },
  { word: "fair", category: "Character", importanceScore: 12 },
  { word: "just", category: "Character", importanceScore: 11 },
  { word: "good", category: "Character", importanceScore: 10 },
  { word: "cool", category: "Character", importanceScore: 10 },
  { word: "ace", category: "Character", importanceScore: 10 },
  { word: "star", category: "Athletics", importanceScore: 10 },
  { word: "pro", category: "Athletics", importanceScore: 10 },
  { word: "champ", category: "Athletics", importanceScore: 10 },
  { word: "gold", category: "Athletics", importanceScore: 10 },
  { word: "grit", category: "Character", importanceScore: 10 },
  { word: "zeal", category: "Character", importanceScore: 10 },
  { word: "moxie", category: "Character", importanceScore: 10 },
  { word: "pluck", category: "Character", importanceScore: 10 },
  { word: "spunk", category: "Character", importanceScore: 10 },
  { word: "verve", category: "Character", importanceScore: 10 },
  { word: "pep", category: "Character", importanceScore: 10 },
  { word: "vim", category: "Character", importanceScore: 10 },
  { word: "gusto", category: "Character", importanceScore: 10 },
  { word: "zing", category: "Character", importanceScore: 10 },
  { word: "zoom", category: "Athletics", importanceScore: 10 },
];

// ─── Tier color mapping ───────────────────────────────────────────────────────
const TIER_COLORS = {
  name: "#000000", // Tier 1 – solid black
  high: "#0000FF", // Tier 2 – bright blue  (score 85+)
  medium: "#00CC00", // Tiers 3 & 4 – bright green (score 50–84)
  filler: "#FF00FF", // Tier 5 – bright magenta (score < 50)
} as const;

function getTierColor(word: string, importanceScore: number): string {
  if (word.toLowerCase() === MOCK_NAME.toLowerCase()) return TIER_COLORS.name;
  if (importanceScore >= 85) return TIER_COLORS.high;
  if (importanceScore >= 50) return TIER_COLORS.medium;
  return TIER_COLORS.filler;
}

// ─── Custom draw – mask overlay + tier colors + center dot ───────────────────
function drawTestFrame(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  placements: PackPlacement[],
  wordScoreMap: Map<string, number>,
): void {
  // 1. White background
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 2. Faint red mask overlay using a temporary canvas + ImageData (fast)
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = MASK_SIZE;
  maskCanvas.height = MASK_SIZE;
  const mCtx = maskCanvas.getContext("2d")!;
  const imgData = mCtx.createImageData(MASK_SIZE, MASK_SIZE);
  for (let i = 0; i < MASK_SIZE * MASK_SIZE; i++) {
    if (mask[i] === 1) {
      const idx = i * 4;
      imgData.data[idx] = 255; // R
      imgData.data[idx + 1] = 0; // G
      imgData.data[idx + 2] = 0; // B
      imgData.data[idx + 3] = 26; // A ≈ 0.1 opacity
    }
  }
  mCtx.putImageData(imgData, 0, 0);
  ctx.drawImage(maskCanvas, 0, 0, CANVAS_W, CANVAS_H);

  // 3. Words with tier-based color overrides
  for (const p of placements) {
    const score = wordScoreMap.get(p.word.toLowerCase()) ?? 0;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.angle) ctx.rotate(p.angle);
    ctx.fillStyle = getTierColor(p.word, score);
    ctx.font = `${p.fontWeight} ${p.fontSize}px "${p.fontFamily}", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.word, 0, 0);
    ctx.restore();
  }

  // 4. 2 px red center-point marker at (cx, cy)
  ctx.fillStyle = "#FF0000";
  ctx.beginPath();
  ctx.arc(CANVAS_W / 2, CANVAS_H / 2, 4, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Stats type ───────────────────────────────────────────────────────────────
interface RenderStats {
  executionTimeMs: number;
  placedCount: number;
  rejectedEstimate: number;
  adherencePct: number;
  uniqueWords: number;
  duplicateWords: number;
  balanceScore: number;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function WordPackerTestHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const [phase, setPhase] = useState<"idle" | "building" | "packing" | "done" | "error">("idle");
  const [packProgress, setPackProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [stats, setStats] = useState<RenderStats | null>(null);

  // Build mask from gymnast SVG on mount
  useEffect(() => {
    setPhase("building");
    buildMaskFromSvg(GYMNAST_SVG, MASK_SIZE)
      .then((mask) => {
        maskRef.current = mask;
        setPhase("idle");
      })
      .catch((e: unknown) => {
        setErrorMsg(String(e));
        setPhase("error");
      });
  }, []);

  // Cleanup worker on unmount
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // Compute approximate total word attempts for rejection estimate
  const computeTotalAttempted = useCallback((): number => {
    const rest = MOCK_WORDS.filter((w) => w.word.toLowerCase() !== MOCK_NAME.toLowerCase());
    const t2 = rest.filter((w) => w.importanceScore >= 85).slice(0, 8).length;
    const t3 = rest
      .filter((w) => w.importanceScore >= 40 && w.importanceScore < 85)
      .slice(0, 80).length;
    const t4 = rest
      .filter((w) => w.importanceScore >= 10 && w.importanceScore < 40)
      .slice(0, 200).length;
    const pool = rest.filter((w) => w.importanceScore < 50);
    const t5Cap = pool.length > 0 ? 400 : 0;
    return 1 + t2 + t3 + t4 + t5Cap;
  }, []);

  const runTest = useCallback(() => {
    const canvas = canvasRef.current;
    const mask = maskRef.current;
    if (!canvas || !mask || phase === "packing" || phase === "building") return;

    workerRef.current?.terminate();

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    setPhase("packing");
    setPackProgress(0);
    setStats(null);
    setErrorMsg(null);

    // Build word score lookup for color overrides
    const wordScoreMap = new Map(MOCK_WORDS.map((w) => [w.word.toLowerCase(), w.importanceScore]));

    const totalAttempted = computeTotalAttempted();
    const startTime = performance.now();

    const opts: PackOptions = {
      width: CANVAS_W,
      height: CANVAS_H,
      name: MOCK_NAME,
      words: MOCK_WORDS,
      fontFamily: "Montserrat",
      bodyFontFamily: "Montserrat",
      nameFontFamily: "Montserrat",
      accentColor: "#FF0000", // overridden during drawing
      primaryColor: "#000000", // overridden during drawing
      bgColor: "#FFFFFF",
      density: 100,
      scaling: 30,
      adherence: 95,
      rotation: 30,
      randomness: 15,
      centerBias: 80,
      emphasis: 4,
      etsyMode: false,
    };

    const worker = new Worker(new URL("../lib/wordPacker.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WordPackerWorkerResponse>) => {
      const msg = event.data;

      if (msg.type === "progress") {
        setPackProgress(msg.progress);
        return;
      }

      if (msg.type === "complete") {
        const elapsed = performance.now() - startTime;
        const { placements, result } = msg.payload;

        drawTestFrame(ctx, mask, placements, wordScoreMap);

        setStats({
          executionTimeMs: Math.round(elapsed),
          placedCount: result.placedCount,
          rejectedEstimate: Math.max(0, totalAttempted - result.placedCount),
          adherencePct: Math.round(result.coverage * 1000) / 10,
          uniqueWords: result.uniqueCount,
          duplicateWords: result.duplicateCount,
          balanceScore: Math.round(result.balanceScore),
        });
        setPackProgress(100);
        setPhase("done");
        worker.terminate();
        workerRef.current = null;
        return;
      }

      // error response
      setErrorMsg(msg.error);
      setPhase("error");
      worker.terminate();
      workerRef.current = null;
    };

    worker.onerror = (e) => {
      setErrorMsg(e.message || "Worker crashed");
      setPhase("error");
      worker.terminate();
      workerRef.current = null;
    };

    const request: WordPackerWorkerRequest = {
      type: "pack",
      payload: { mask, maskSize: MASK_SIZE, opts },
    };
    worker.postMessage(request);
  }, [phase, computeTotalAttempted]);

  const isBusy = phase === "building" || phase === "packing";

  return (
    <div className="min-h-screen bg-neutral-100 p-6 font-mono text-sm">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
          🔬 WordPacker Test Harness
        </h1>
        <p className="mt-1 text-neutral-500">
          Mock student: <strong className="text-neutral-700">{MOCK_NAME}</strong> &middot; 71 words
          (1 name, 5 high, 15 medium, 50 filler) &middot; Gymnast mask &middot; {CANVAS_W}&times;
          {CANVAS_H}px canvas
        </p>
      </div>

      {/* Run button */}
      <button
        onClick={runTest}
        disabled={isBusy}
        className="mb-4 rounded px-5 py-2 text-sm font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        style={{ backgroundColor: isBusy ? "#94a3b8" : "#2563eb" }}
      >
        {phase === "building"
          ? "⏳ Building Mask…"
          : phase === "packing"
            ? `⏳ Packing… ${packProgress}%`
            : "▶ Run Test"}
      </button>

      {/* Progress bar */}
      {phase === "packing" && (
        <div className="mb-4 w-full max-w-xl">
          <Progress value={packProgress} className="h-2" />
        </div>
      )}

      {/* Color legend */}
      <div className="mb-4 flex flex-wrap gap-4 text-xs">
        {[
          { label: "Tier 1 — Name (cx, cy anchor)", color: TIER_COLORS.name, border: true },
          { label: "Tier 2 — Score 85+", color: TIER_COLORS.high },
          { label: "Tiers 3 & 4 — Score 50–84", color: TIER_COLORS.medium },
          { label: "Tier 5 — Score < 50", color: TIER_COLORS.filler },
          { label: "Red dot — center (cx, cy)", color: "#FF0000" },
          { label: "Faint red bg — mask region", color: "rgba(255,0,0,0.15)" },
        ].map(({ label, color, border }) => (
          <span key={label} className="flex items-center gap-1.5">
            <span
              style={{
                width: 14,
                height: 14,
                background: color,
                display: "inline-block",
                borderRadius: 3,
                border: border ? "1px solid #999" : undefined,
                flexShrink: 0,
              }}
            />
            {label}
          </span>
        ))}
      </div>

      {/* Canvas */}
      <div
        style={{
          display: "inline-block",
          border: "2px solid #cbd5e1",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ display: "block", maxWidth: "100%", maxHeight: "75vh" }}
        />
      </div>

      {/* Error message */}
      {phase === "error" && errorMsg && <p className="mt-3 text-red-600">⚠ Error: {errorMsg}</p>}

      {/* Stats panel */}
      {stats && (
        <div className="mt-5 max-w-xl rounded-lg bg-neutral-900 p-5 text-neutral-300">
          <p className="mb-3 text-sm font-bold text-emerald-400">📊 Render Statistics</p>
          <pre className="m-0 text-xs leading-relaxed">
            {JSON.stringify(
              {
                executionTime: `${stats.executionTimeMs} ms`,
                wordsPlaced: stats.placedCount,
                wordsRejectedEstimate: stats.rejectedEstimate,
                shapeAdherence: `${stats.adherencePct}%`,
                uniqueWords: stats.uniqueWords,
                duplicateWords: stats.duplicateWords,
                balanceScore: stats.balanceScore,
              },
              null,
              2,
            )}
          </pre>
          <p className="mt-3 text-xs text-neutral-500">
            * rejectedEstimate = totalAttemptsEstimated ({computeTotalAttempted()}) − placedCount
          </p>
        </div>
      )}
    </div>
  );
}
