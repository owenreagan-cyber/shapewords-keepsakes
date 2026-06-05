import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import saveAs from "file-saver";
import JSZip from "jszip";
import {
  STUDENTS,
  FONT_OPTIONS,
  THEMES,
  SILHOUETTE_STYLES,
  OPTIMIZATION_PRESETS,
  type Student,
} from "@/lib/students";
import { callShapeGen, callWordExpansion, FALLBACK_HEART_SVG, type WordEntry } from "@/lib/gemini";
import {
  buildMaskFromSvg,
  detectMaskOrientation,
  drawPlacements,
  type MaskOrientation,
  type PackOptions,
  type PackResult,
  type WordPackerWorkerRequest,
  type WordPackerWorkerResponse,
} from "@/lib/wordPacker";
import { Progress } from "@/components/ui/progress";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ShapeWords Studio — Word Art Generator" },
      {
        name: "description",
        content:
          "Professional word art generator for Grade 4 classroom keepsakes. Print-ready 8x10 @ 300 DPI.",
      },
      { property: "og:title", content: "ShapeWords Studio" },
      {
        property: "og:description",
        content: "Professional word art generator for classroom keepsakes.",
      },
    ],
  }),
  component: ShapeWordsApp,
});

const EXPORT_RES = {
  preview: { w: 1200, h: 1500, label: "1200px (Preview)" },
  print: { w: 3000, h: 3750, label: "3000x3750px (8x10 @ 300 DPI)" },
  tall: { w: 3000, h: 6000, label: "3000x6000px (5x10 @ 300 DPI)" },
  ultra: { w: 6000, h: 12000, label: "6000x12000px (Ultra)" },
};

const ORIENTATION_OUTPUT_RES: Record<MaskOrientation, { w: number; h: number }> = {
  portrait: { w: 2400, h: 3000 },
  landscape: { w: 3000, h: 2400 },
};

type Config = {
  fontFamily: string;
  theme: string;
  emphasis: number; // 1-5
  density: number; // 10-100
  scaling: number; // 10-50
  adherence: number; // 10-100
  rotation: number; // 0-100
  randomness: number; // 0-100
  centerBias: number; // 0-100
  silhouetteStyle: string;
  preset: string;
  resolution: keyof typeof EXPORT_RES;
  etsyMode: boolean;
};

type QualityScores = {
  shapeRecognition: number;
  wordDiversity: number;
  visualBalance: number;
  printQuality: number;
  typography: number;
  coverage: number;
  overall: number;
  uniqueWords: number;
  duplicateWords: number;
};

type RenderJob = {
  canvas: HTMLCanvasElement;
  student: Student;
  config: Config;
  size: { w: number; h: number };
  svg: string;
  words: WordEntry[];
  mask?: Uint8Array;
  maskSize?: number;
  onProgress?: (progress: number) => void;
  syncState?: boolean;
};

function defaultConfig(s: Student): Config {
  return {
    fontFamily: s.fontFamily,
    theme: "Classic B&W",
    emphasis: s.emphasis === "High" ? 4 : s.emphasis === "Medium" ? 3 : 2,
    density: s.density,
    scaling: 25,
    adherence: 92,
    rotation: 25,
    randomness: 15,
    centerBias: 85,
    silhouetteStyle: "Premium Print",
    preset: "Premium Print",
    resolution: "print",
    etsyMode: true,
  };
}

function getCanvasSizeForResolution(
  resolution: keyof typeof EXPORT_RES,
  orientation: MaskOrientation,
): { w: number; h: number } {
  if (resolution === "print") return ORIENTATION_OUTPUT_RES[orientation];
  return EXPORT_RES[resolution];
}

function ShapeWordsApp() {
  const [students, setStudents] = useState<Student[]>(STUDENTS);
  const [activeId, setActiveId] = useState(STUDENTS[0].id);
  const active = useMemo(() => students.find((s) => s.id === activeId)!, [students, activeId]);
  const [config, setConfig] = useState<Config>(defaultConfig(active));
  const [nameField, setNameField] = useState(active.name);
  const [traitsField, setTraitsField] = useState(active.traits);
  const [shapeField, setShapeField] = useState(active.shape);
  const [words, setWords] = useState<WordEntry[]>([]);
  const [shapeSvg, setShapeSvg] = useState<string>(FALLBACK_HEART_SVG);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [placedCount, setPlacedCount] = useState(0);
  const [quality, setQuality] = useState<QualityScores | null>(null);
  const [zoom, setZoom] = useState(100);
  const [batchProgress, setBatchProgress] = useState<{ i: number; total: number } | null>(null);
  const [packingProgress, setPackingProgress] = useState<number | null>(null);
  const [maskOrientation, setMaskOrientation] = useState<MaskOrientation>("portrait");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<{ mask: Uint8Array; size: number } | null>(null);
  const workersRef = useRef<Set<Worker>>(new Set());
  const currentStudent = useMemo(
    () => ({ ...active, name: nameField, traits: traitsField, shape: shapeField }),
    [active, nameField, traitsField, shapeField],
  );

  useEffect(() => {
    const workers = workersRef.current;
    return () => {
      for (const worker of workers) worker.terminate();
      workers.clear();
    };
  }, []);

  // when active student changes, reset fields and auto-generate their shape
  useEffect(() => {
    setNameField(active.name);
    setTraitsField(active.traits);
    setShapeField(active.shape);
    setConfig(defaultConfig(active));
    setWords([]);
    setShapeSvg(FALLBACK_HEART_SVG);
    setQuality(null);

    let cancel = false;
    setBusy(true);
    setStatus("Generating shape...");
    callShapeGen(active.shape, "Premium Print")
      .then((svg) => {
        if (!cancel) setShapeSvg(svg);
      })
      .catch(() => {
        // keep fallback heart on error
      })
      .finally(() => {
        if (!cancel) {
          setBusy(false);
          setStatus(null);
        }
      });
    return () => {
      cancel = true;
    };
  }, [activeId]); // eslint-disable-line

  // build mask whenever svg changes
  useEffect(() => {
    let cancel = false;
    Promise.all([
      buildMaskFromSvg(shapeSvg, 512).catch(() => buildMaskFromSvg(FALLBACK_HEART_SVG, 512)),
      detectMaskOrientation(shapeSvg).catch(() => detectMaskOrientation(FALLBACK_HEART_SVG)),
    ]).then(([mask, orientation]) => {
      if (cancel) return;
      maskRef.current = { mask, size: 512 };
      setMaskOrientation(orientation);
    });
    return () => {
      cancel = true;
    };
  }, [shapeSvg]);

  const packWordsWithWorker = useCallback(
    async (
      ctx: CanvasRenderingContext2D,
      mask: Uint8Array,
      maskSize: number,
      opts: PackOptions,
      onProgress?: (progress: number) => void,
    ): Promise<PackResult> =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL("../lib/wordPacker.worker.ts", import.meta.url), {
          type: "module",
        });
        workersRef.current.add(worker);

        const cleanup = () => {
          workersRef.current.delete(worker);
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
            drawPlacements(
              ctx,
              opts.width,
              opts.height,
              opts.bgColor ?? "#FFFFFF",
              message.payload.placements,
            );
            cleanup();
            onProgress?.(100);
            resolve(message.payload.result);
            return;
          }
          cleanup();
          reject(new Error(message.error));
        };

        worker.onerror = (event) => {
          cleanup();
          reject(new Error(event.message || "Word packing worker failed"));
        };

        onProgress?.(0);
        const request: WordPackerWorkerRequest = {
          type: "pack",
          payload: { mask, maskSize, opts },
        };
        worker.postMessage(request);
      }),
    [],
  );

  const renderWordArt = useCallback(
    async ({
      canvas,
      student,
      config: renderConfig,
      size,
      svg,
      words: rawWords,
      mask,
      maskSize = 512,
      onProgress,
      syncState = false,
    }: RenderJob) => {
      canvas.width = size.w;
      canvas.height = size.h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable");

      const effectiveMask = mask
        ? { mask, size: maskSize }
        : { mask: await buildMaskFromSvg(svg, maskSize), size: maskSize };
      const wordSet = normalizeWordEntries(student.name, rawWords, student.traits);
      const accent = student.colorPalette[1] ?? "#D97706";
      const typography = pickTypographyPair(renderConfig.fontFamily, renderConfig.etsyMode);

      if (syncState) setPackingProgress(0);
      try {
        const result = await packWordsWithWorker(
          ctx,
          effectiveMask.mask,
          effectiveMask.size,
          {
            width: size.w,
            height: size.h,
            name: student.name,
            words: wordSet,
            theme: student.theme,
            fontFamily: renderConfig.fontFamily,
            bodyFontFamily: typography.bodyFont,
            nameFontFamily: typography.nameFont,
            accentColor: accent,
            primaryColor: student.colorPalette[0] ?? "#000000",
            bgColor: "#FFFFFF",
            density: renderConfig.density,
            scaling: renderConfig.scaling,
            adherence: renderConfig.adherence,
            rotation: renderConfig.rotation,
            randomness: renderConfig.randomness,
            centerBias: renderConfig.centerBias,
            emphasis: renderConfig.emphasis,
            etsyMode: renderConfig.etsyMode,
          },
          onProgress ?? (syncState ? setPackingProgress : undefined),
        );
        drawShapeOutline(ctx, svg, size.w, size.h);
        if (syncState) {
          setPlacedCount(result.placedCount);
          setQuality(scoreLayout(result, wordSet, renderConfig));
        }
        return result;
      } finally {
        if (syncState) setPackingProgress(null);
      }
    },
    [packWordsWithWorker],
  );

  const renderToCanvas = useCallback(
    async (
      targetCanvas?: HTMLCanvasElement,
      sizeOverride?: { w: number; h: number },
      wordsOverride?: WordEntry[],
      shapeOverride?: string,
    ) => {
      const canvas = targetCanvas ?? canvasRef.current;
      if (!canvas) return null;
      const svg = shapeOverride ?? shapeSvg;
      const activeMask =
        !shapeOverride && maskRef.current
          ? maskRef.current
          : {
              mask: await buildMaskFromSvg(svg, 512),
              size: 512,
            };
      const orientation = shapeOverride ? await detectMaskOrientation(svg) : maskOrientation;

      return renderWordArt({
        canvas,
        student: currentStudent,
        config,
        size: sizeOverride ?? getCanvasSizeForResolution(config.resolution, orientation),
        svg,
        words: wordsOverride ?? (words.length > 0 ? words : seedFromTraits(nameField, traitsField)),
        mask: activeMask.mask,
        maskSize: activeMask.size,
        syncState: true,
      });
    },
    [
      config,
      currentStudent,
      maskOrientation,
      nameField,
      renderWordArt,
      shapeSvg,
      traitsField,
      words,
    ],
  );

  // initial render on mount + config / student change
  useEffect(() => {
    const t = setTimeout(() => {
      renderToCanvas().catch(console.error);
    }, 100);
    return () => clearTimeout(t);
  }, [renderToCanvas]);

  const handleGenerate = async () => {
    setBusy(true);
    setStatus("Calling Gemini...");
    try {
      const accent = active.colorPalette[1] ?? "#D97706";
      const [expansion, svg] = await Promise.all([
        callWordExpansion({
          name: nameField,
          traits: traitsField,
          theme: config.theme,
          aiExpansionProfile: active.aiExpansionProfile,
          preset: config.preset,
          fontFamily: config.fontFamily,
          accentColor: accent,
        }).catch((e) => {
          console.warn("Word expansion failed:", e);
          return null;
        }),
        callShapeGen(shapeField, config.silhouetteStyle).catch((e) => {
          console.warn("Shape gen failed, fallback:", e);
          return FALLBACK_HEART_SVG;
        }),
      ]);
      setStatus("Building mask...");
      setShapeSvg(svg);
      maskRef.current = { mask: await buildMaskFromSvg(svg, 512), size: 512 };
      const generatedWords = expansion?.words?.length
        ? normalizeWordEntries(nameField, expansion.words, traitsField)
        : normalizeWordEntries(nameField, seedFromTraits(active.name, traitsField), traitsField);
      setWords(generatedWords);
      if (expansion?.words?.length && expansion.design) {
        setConfig((c) => ({
          ...c,
          fontFamily: expansion.design.fontFamily || c.fontFamily,
          density: clamp(expansion.design.density ?? c.density, 10, 100),
          scaling: clamp(expansion.design.scaling ?? c.scaling, 10, 50),
          adherence: clamp(expansion.design.adherence ?? c.adherence, 10, 100),
          centerBias: clamp(expansion.design.centerBias ?? c.centerBias, 0, 100),
          rotation: clamp(expansion.design.rotation ?? c.rotation, 0, 100),
          randomness: clamp(expansion.design.randomness ?? c.randomness, 0, 100),
        }));
      }
      setStatus("Packing words...");
      await new Promise((r) => setTimeout(r, 50));
      let best = await renderToCanvas(undefined, undefined, generatedWords, svg);
      const maxAttempts = 4;
      let attempt = 1;
      while (attempt < maxAttempts) {
        const current = best ? scoreLayout(best, generatedWords, config) : null;
        if (current && current.overall >= 90) break;
        attempt++;
        setStatus(`Refining layout (${attempt}/${maxAttempts})...`);
        const next = await renderToCanvas(undefined, undefined, generatedWords, svg);
        if (
          !best ||
          (next &&
            next.balanceScore + next.coverage * 100 > best.balanceScore + best.coverage * 100)
        ) {
          best = next;
        }
      }
      setStatus("Quality check complete");
      await new Promise((r) => setTimeout(r, 250));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus("Error: " + message);
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      setPackingProgress(null);
      setStatus(null);
      setBusy(false);
    }
  };

  const handleRegenerate = async () => {
    setBusy(true);
    setStatus("Packing words...");
    try {
      await renderToCanvas();
    } finally {
      setPackingProgress(null);
      setStatus(null);
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    await renderToCanvas(canvas, getCanvasSizeForResolution("print", maskOrientation));
    const data = canvas.toDataURL("image/jpeg", 0.95);
    triggerDownload(data, `${nameField}_WordArt_8x10_300dpi.jpg`);
  };

  const handleBatchExport = async () => {
    setBusy(true);
    setPackingProgress(null);
    setBatchProgress({ i: 0, total: students.length });
    const zip = new JSZip();
    const off = document.createElement("canvas");
    try {
      for (let i = 0; i < students.length; i++) {
        const s = students[i];
        const studentConfig = {
          ...defaultConfig(s),
          theme: s.theme,
          preset: s.printPreset,
          silhouetteStyle: s.printPreset,
        };
        const accent = s.colorPalette[1] ?? "#D97706";

        setBatchProgress({ i: i + 1, total: students.length });
        setStatus(`Processing Student ${i + 1} of ${students.length}`);
        const [expansion, svg] = await Promise.all([
          callWordExpansion({
            name: s.name,
            traits: s.traits,
            theme: s.theme,
            aiExpansionProfile: s.aiExpansionProfile,
            preset: studentConfig.preset,
            fontFamily: studentConfig.fontFamily,
            accentColor: accent,
          }).catch((error) => {
            console.warn("Batch word expansion failed:", s.name, error);
            return null;
          }),
          callShapeGen(s.shape, studentConfig.silhouetteStyle).catch((error) => {
            console.warn("Batch shape generation failed:", s.name, error);
            return FALLBACK_HEART_SVG;
          }),
        ]);
        const orientation = await detectMaskOrientation(svg);
        const mask = await buildMaskFromSvg(svg, 512);

        setPackingProgress(0);
        await renderWordArt({
          canvas: off,
          student: s,
          config: studentConfig,
          size: ORIENTATION_OUTPUT_RES[orientation],
          svg,
          words: expansion?.words?.length ? expansion.words : seedFromTraits(s.name, s.traits),
          mask,
          onProgress: setPackingProgress,
        });
        const blob = await canvasToBlob(off, "image/png");
        zip.file(`${toSafeFilenamePart(s.name)}-wordart.png`, blob);
      }
      setStatus("Creating ZIP...");
      const blob = await zip.generateAsync({ type: "blob" });
      saveAs(blob, "Class-Keepsakes.zip");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus("Batch failed: " + message);
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      setPackingProgress(null);
      setStatus(null);
      setBatchProgress(null);
      setBusy(false);
    }
  };

  return (
    <div className="h-screen w-full flex flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="h-12 flex items-center justify-between px-5 border-b border-panel-border bg-panel shrink-0">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl tracking-wider text-foreground leading-none">
            SHAPEWORDS <span className="text-amber-accent">STUDIO</span>
          </h1>
          <span className="label-mini">v1.0 • Print Studio</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>25 students loaded</span>
          <span className="text-amber-accent">●</span>
          <span>Ready</span>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-[300px_1fr_280px] min-h-0">
        {/* LEFT SIDEBAR */}
        <aside className="panel border-r border-panel-border overflow-y-auto">
          <Section title="AI Shape Studio">
            <Field label="Shape Description">
              <input
                value={shapeField}
                onChange={(e) => setShapeField(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Silhouette Style">
              <Select
                value={config.silhouetteStyle}
                onChange={(v) => setConfig((c) => ({ ...c, silhouetteStyle: v }))}
                options={SILHOUETTE_STYLES}
              />
            </Field>
          </Section>

          <Section title="Student Data">
            <Field label="Student Name">
              <input
                value={nameField}
                onChange={(e) => setNameField(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Traits / Words">
              <textarea
                value={traitsField}
                onChange={(e) => setTraitsField(e.target.value)}
                rows={3}
                className={inputCls + " resize-none"}
              />
            </Field>
          </Section>

          <div className="border-t border-panel-border" style={{ background: "var(--amber-tint)" }}>
            <Section title="AI Optimizer" tinted>
              <Field label="Optimization Preset">
                <Select
                  value={config.preset}
                  onChange={(v) => setConfig((c) => ({ ...c, preset: v }))}
                  options={OPTIMIZATION_PRESETS}
                />
              </Field>
              <label className="flex items-center justify-between text-xs text-foreground">
                <span className="label-mini">Etsy Bestseller Mode</span>
                <input
                  type="checkbox"
                  checked={config.etsyMode}
                  onChange={(e) => setConfig((c) => ({ ...c, etsyMode: e.target.checked }))}
                  className="accent-amber-accent"
                />
              </label>
              <button
                onClick={handleGenerate}
                disabled={busy}
                className="w-full mt-2 py-2.5 text-xs font-bold tracking-widest uppercase text-amber-foreground disabled:opacity-40"
                style={{
                  background: "linear-gradient(135deg, #D97706, #B45309)",
                  color: "#0A0A0A",
                }}
              >
                {busy ? "Working..." : "✨ Generate Best Possible Design"}
              </button>
            </Section>
          </div>

          <Section title="Word Packing Engine">
            <Field label="Font Family">
              <Select
                value={config.fontFamily}
                onChange={(v) => setConfig((c) => ({ ...c, fontFamily: v }))}
                options={FONT_OPTIONS}
              />
            </Field>
            <Field label="Visual Theme">
              <Select
                value={config.theme}
                onChange={(v) => setConfig((c) => ({ ...c, theme: v }))}
                options={THEMES}
              />
            </Field>
            <Slider
              label="Emphasis"
              min={1}
              max={5}
              step={1}
              value={config.emphasis}
              valueLabel={["", "None", "Low", "Medium", "High", "Extreme"][config.emphasis]}
              onChange={(v) => setConfig((c) => ({ ...c, emphasis: v }))}
            />
            <Slider
              label="Density"
              min={10}
              max={100}
              value={config.density}
              valueLabel={config.density + "%"}
              onChange={(v) => setConfig((c) => ({ ...c, density: v }))}
            />
            <Slider
              label="Word Scaling"
              min={10}
              max={50}
              value={config.scaling}
              valueLabel={(config.scaling / 10).toFixed(1) + "x"}
              onChange={(v) => setConfig((c) => ({ ...c, scaling: v }))}
            />
            <Slider
              label="Shape Adherence"
              min={10}
              max={100}
              value={config.adherence}
              valueLabel={config.adherence + "%"}
              onChange={(v) => setConfig((c) => ({ ...c, adherence: v }))}
            />
            <Slider
              label="Rotation Chance"
              min={0}
              max={100}
              value={config.rotation}
              valueLabel={config.rotation + "%"}
              onChange={(v) => setConfig((c) => ({ ...c, rotation: v }))}
            />
            <Slider
              label="Randomness"
              min={0}
              max={100}
              value={config.randomness}
              valueLabel={config.randomness + "%"}
              onChange={(v) => setConfig((c) => ({ ...c, randomness: v }))}
            />
            <Slider
              label="Center Bias"
              min={0}
              max={100}
              value={config.centerBias}
              valueLabel={config.centerBias + "%"}
              onChange={(v) => setConfig((c) => ({ ...c, centerBias: v }))}
            />
          </Section>

          <Section title="Export Resolution">
            <Field label="Resolution">
              <Select
                value={config.resolution}
                onChange={(v) =>
                  setConfig((c) => ({ ...c, resolution: v as Config["resolution"] }))
                }
                options={[
                  { value: "preview", label: EXPORT_RES.preview.label },
                  { value: "print", label: EXPORT_RES.print.label },
                  { value: "tall", label: EXPORT_RES.tall.label },
                  { value: "ultra", label: EXPORT_RES.ultra.label },
                ]}
              />
            </Field>
          </Section>
        </aside>

        {/* CENTER CANVAS */}
        <main className="relative dot-grid overflow-hidden flex flex-col">
          <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
            <div className="px-3 py-1.5 bg-panel border border-panel-border">
              <span className="label-mini">Current</span>{" "}
              <span className="text-foreground font-bold text-sm ml-1">{active.name}</span>
            </div>
            <div className="px-3 py-1.5 bg-panel border border-panel-border">
              <span className="label-mini">{placedCount} words packed</span>
            </div>
            {quality && (
              <div className="px-3 py-1.5 bg-panel border border-panel-border">
                <span className="label-mini">Quality {Math.round(quality.overall)}</span>
              </div>
            )}
          </div>

          <div className="flex-1 flex items-center justify-center p-8 min-h-0">
            <div
              className="relative bg-white shadow-[0_0_60px_rgba(0,0,0,0.6)]"
              style={{
                aspectRatio: `${getCanvasSizeForResolution(config.resolution, maskOrientation).w} / ${getCanvasSizeForResolution(config.resolution, maskOrientation).h}`,
                height: `${zoom}%`,
                maxHeight: "100%",
                maxWidth: "100%",
              }}
            >
              <canvas
                ref={canvasRef}
                className="block w-full h-full"
                style={{ objectFit: "contain" }}
              />
              {(status || busy || packingProgress !== null) && (
                <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-3 backdrop-blur-sm">
                  <div className="w-10 h-10 border-2 border-amber-accent border-t-transparent rounded-full animate-spin" />
                  <div className="text-amber-accent text-xs tracking-widest uppercase">
                    {status || (packingProgress !== null ? "Packing words..." : "Working...")}
                  </div>
                  {packingProgress !== null && (
                    <div className="w-64 space-y-1">
                      <Progress value={packingProgress} className="h-2 bg-panel-border" />
                      <div className="text-[10px] text-muted-foreground text-center">
                        {packingProgress}%
                      </div>
                    </div>
                  )}
                  {batchProgress && (
                    <div className="w-64 h-1 bg-panel-border mt-2">
                      <div
                        className="h-full bg-amber-accent transition-all"
                        style={{ width: `${(batchProgress.i / batchProgress.total) * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="h-12 border-t border-panel-border bg-panel flex items-center justify-between px-5 shrink-0">
            <div className="flex items-center gap-3">
              <span className="label-mini">Zoom</span>
              <input
                type="range"
                min={40}
                max={150}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-32 accent-amber-accent"
                style={{ accentColor: "#D97706" }}
              />
              <span className="text-xs text-muted-foreground">{zoom}%</span>
            </div>
            <button
              onClick={handleRegenerate}
              disabled={busy}
              className="px-4 py-1.5 border border-amber-accent text-amber-accent text-xs tracking-widest uppercase hover:bg-amber-tint disabled:opacity-40"
            >
              ↻ Regenerate Layout
            </button>
          </div>
        </main>

        {/* RIGHT SIDEBAR */}
        <aside className="panel border-l border-panel-border overflow-y-auto flex flex-col">
          <div className="px-4 py-3 border-b border-panel-border flex items-center justify-between shrink-0">
            <h2 className="font-display text-lg tracking-wider">CLASS ROSTER</h2>
            <label className="text-[10px] tracking-widest uppercase text-amber-accent cursor-pointer hover:underline">
              Import CSV
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={() => alert("CSV import: stub")}
              />
            </label>
          </div>

          <div className="flex-1 overflow-y-auto">
            {students.map((s) => {
              const isActive = s.id === activeId;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className={`w-full text-left px-4 py-2.5 border-b border-panel-border flex items-center gap-3 hover:bg-input transition-colors ${
                    isActive ? "border-l-4" : ""
                  }`}
                  style={{
                    borderLeftColor: isActive ? "#D97706" : "transparent",
                    background: isActive ? "var(--amber-tint)" : undefined,
                  }}
                >
                  <div
                    className="w-3 h-8 shrink-0"
                    style={{ background: s.colorPalette[1] ?? "#D97706" }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-sm text-foreground truncate">{s.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{s.shape}</div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-panel-border p-3 space-y-2 shrink-0">
            <div className="text-[10px] tracking-widest uppercase text-amber-accent">
              Current export: JPG • Batch export: PNG ZIP
            </div>
            {quality && (
              <div className="border border-panel-border p-2 bg-input/40 space-y-1">
                <div className="text-[10px] tracking-widest uppercase text-amber-accent">
                  Live quality scoring
                </div>
                <QualityRow label="Overall" value={quality.overall} />
                <QualityRow label="Shape" value={quality.shapeRecognition} />
                <QualityRow label="Diversity" value={quality.wordDiversity} />
                <QualityRow label="Balance" value={quality.visualBalance} />
                <QualityRow label="Coverage" value={quality.coverage} />
                <QualityRow label="Typography" value={quality.typography} />
                <QualityRow label="Print" value={quality.printQuality} />
                <div className="text-[10px] text-muted-foreground">
                  {quality.uniqueWords} unique · {quality.duplicateWords} duplicate
                </div>
              </div>
            )}
            <button
              onClick={handleDownload}
              disabled={busy}
              className="w-full py-2.5 bg-amber-accent text-[#0A0A0A] text-xs font-bold tracking-widest uppercase disabled:opacity-40"
              style={{ background: "#D97706" }}
            >
              ⬇ Download Current
            </button>
            <button
              onClick={handleBatchExport}
              disabled={busy}
              className="w-full py-2.5 border border-amber-accent text-amber-accent text-xs font-bold tracking-widest uppercase hover:bg-amber-tint disabled:opacity-40"
            >
              📦 Batch Render
            </button>
            <button
              onClick={() => {
                const id = String(Date.now());
                const ns: Student = {
                  id,
                  name: "New Student",
                  shape: "Star silhouette",
                  traits: "kind, smart, creative",
                  interests: [],
                  theme: "Custom",
                  colorPalette: ["#000000", "#D97706"],
                  fontFamily: "Bebas Neue",
                  density: 90,
                  emphasis: "High",
                  layoutStrategy: "Center Dominant",
                  aiExpansionProfile: "Kid-friendly Positive Character Traits",
                  printPreset: "Premium Print",
                };
                setStudents((s) => [...s, ns]);
                setActiveId(id);
              }}
              className="w-full py-2 border border-panel-border text-xs tracking-widest uppercase text-muted-foreground hover:text-foreground"
            >
              + Add Student
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to create export blob"));
        return;
      }
      resolve(blob);
    }, type);
  });
}

function toSafeFilenamePart(value: string) {
  const cleaned = [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && !/[<>:"/\\|?*]/.test(char);
    })
    .join("")
    .trim();
  return cleaned || "student";
}

const PROFESSIONAL_FILLER = [
  "kind",
  "caring",
  "supportive",
  "thoughtful",
  "empathetic",
  "patient",
  "encouraging",
  "respectful",
  "welcoming",
  "inclusive",
  "compassionate",
  "helpful",
  "uplifting",
  "calm",
  "gentle",
  "sincere",
  "trustworthy",
  "reliable",
  "dependable",
  "honest",
  "responsible",
  "dedicated",
  "focused",
  "motivated",
  "hardworking",
  "resilient",
  "determined",
  "persistent",
  "confident",
  "brave",
  "bold",
  "strong",
  "steadfast",
  "disciplined",
  "goal-oriented",
  "curious",
  "creative",
  "imaginative",
  "innovative",
  "inventive",
  "expressive",
  "artistic",
  "resourceful",
  "clever",
  "insightful",
  "problem-solver",
  "lifelong learner",
  "thoughtful leader",
  "team player",
  "cooperative",
  "diplomatic",
  "grateful",
  "joyful",
  "positive",
  "optimistic",
  "cheerful",
  "friendly",
  "loyal",
  "warm-hearted",
  "kind-hearted",
  "good listener",
  "selfless",
  "mindful",
  "adaptable",
  "attentive",
  "balanced",
  "poised",
  "graceful",
  "athletic",
  "energetic",
  "spirited",
  "quick-thinking",
  "capable",
  "determined learner",
  "excellent teammate",
  "inspiring",
  "courageous",
  "steady",
  "empathetic leader",
  "service-minded",
  "community-minded",
  "citizenship",
  "integrity",
  "character",
  "integrity-driven",
  "supportive friend",
  "creative thinker",
  "future leader",
  "academic achiever",
  "organized",
  "prepared",
  "driven",
  "engaged",
  "reflective",
  "curiosity",
  "perseverance",
  "leadership",
  "friendship",
  "kindness",
  "responsibility",
  "citizenship-minded",
  "determination",
  "compassion",
  "generosity",
  "humility",
  "self-control",
  "initiative",
  "dedication",
  "consistency",
  "confidence",
  "optimism",
  "growth mindset",
  "respects others",
  "values teamwork",
  "supports peers",
  "encourages others",
  "leads by example",
  "acts with integrity",
  "pursues excellence",
  "takes initiative",
  "builds others up",
  "celebrates others",
  "performs with heart",
  "works with purpose",
  "learns with joy",
  "approaches challenges",
  "solves problems",
  "stays positive",
  "shows gratitude",
  "shows courage",
  "shows resilience",
  "shows patience",
  "shows kindness",
  "shows leadership",
  "shows creativity",
  "shows discipline",
  "shows confidence",
  "shows empathy",
  "shows character",
];

const BLOCKED_PATTERNS = [
  /beautiful|cute|pretty|handsome|gorgeous|hot|sexy|attractive/i,
  /boyfriend|girlfriend|romantic|crush|kiss|dating|flirt/i,
  /baby|adorable|cuddly|cutie/i,
];

function sanitizeWord(input: string) {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length < 3 || cleaned.length > 28) return "";
  if (!/[a-z]/i.test(cleaned)) return "";
  if (BLOCKED_PATTERNS.some((p) => p.test(cleaned))) return "";
  if (/([a-z])\1{3,}/i.test(cleaned)) return "";
  return cleaned;
}

function normalizeWordEntries(name: string, entries: WordEntry[], traits: string): WordEntry[] {
  const normalized: WordEntry[] = [];
  const seen = new Set<string>();
  const traitWords = traits
    .split(",")
    .map((t) => sanitizeWord(t))
    .filter(Boolean);

  const fallback = seedFromTraits(name, traits);
  const merged = [...entries, ...fallback];
  for (const entry of merged) {
    const clean = sanitizeWord(entry.word);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (key === name.toLowerCase()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      word: clean,
      category: entry.category || "Character",
      importanceScore: clamp(entry.importanceScore ?? 25, 10, 100),
    });
  }

  for (const trait of traitWords) {
    for (const phrase of [trait, `${trait} mindset`, `${trait} spirit`, `${trait} leader`]) {
      const clean = sanitizeWord(phrase);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({ word: clean, category: "Character", importanceScore: 60 });
    }
  }

  while (normalized.length < 220) {
    const candidate = PROFESSIONAL_FILLER[normalized.length % PROFESSIONAL_FILLER.length];
    const clean = sanitizeWord(candidate);
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      normalized.push({
        word: clean,
        category: "Character",
        importanceScore: 20 + (normalized.length % 20),
      });
    } else if (traitWords.length) {
      const trait = traitWords[normalized.length % traitWords.length];
      const variant = sanitizeWord(`${trait} excellence`);
      if (variant && !seen.has(variant.toLowerCase())) {
        seen.add(variant.toLowerCase());
        normalized.push({ word: variant, category: "Character", importanceScore: 22 });
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return [{ word: name, category: "Name", importanceScore: 95 }, ...normalized.slice(0, 320)];
}

function seedFromTraits(name: string, traits: string): WordEntry[] {
  const list = traits
    .split(",")
    .map((t) => sanitizeWord(t))
    .filter(Boolean);
  const entries: WordEntry[] = [];
  entries.push({ word: name, category: "Name", importanceScore: 1000 });
  list.forEach((t) => entries.push({ word: t, category: "Character", importanceScore: 90 }));
  PROFESSIONAL_FILLER.forEach((w, i) =>
    entries.push({
      word: w,
      category: "Character",
      importanceScore: i < 40 ? 55 : i < 90 ? 35 : 20,
    }),
  );
  return entries;
}

function pickTypographyPair(fontFamily: string, etsyMode: boolean) {
  if (!etsyMode) return { nameFont: fontFamily, bodyFont: fontFamily };
  if (["Great Vibes", "Caveat"].includes(fontFamily)) {
    return { nameFont: "Playfair Display", bodyFont: "Inter" };
  }
  if (["Bebas Neue", "Impact", "Oswald", "Orbitron"].includes(fontFamily)) {
    return { nameFont: "Cinzel", bodyFont: "Montserrat" };
  }
  return { nameFont: "Playfair Display", bodyFont: "Inter" };
}

function scoreLayout(result: PackResult, words: WordEntry[], config: Config): QualityScores {
  const sourceUnique = new Set(words.map((w) => w.word.toLowerCase())).size;
  const sourceDiversity = clamp((sourceUnique / 220) * 100, 0, 100);
  const wordDiversity = clamp(sourceDiversity * 0.6 + result.diversityScore * 0.4, 0, 100);
  const coverage = clamp(100 - Math.abs(result.coverage - 0.94) * 320, 0, 100);
  const typography =
    clamp(100 - Math.abs(result.nameAreaPct - 11.5) * 5, 0, 100) * 0.6 +
    clamp(100 - Math.abs(result.accentRatio - 15) * 4, 0, 100) * 0.4;
  const shapeRecognition = clamp(result.coverage * 100 * 0.6 + result.balanceScore * 0.4, 0, 100);
  const printQuality = clamp(
    92 - Math.max(0, result.duplicateCount - 6) * 0.15 - (config.etsyMode ? 0 : 3),
    0,
    100,
  );
  const overall =
    shapeRecognition * 0.2 +
    wordDiversity * 0.2 +
    result.balanceScore * 0.2 +
    printQuality * 0.15 +
    typography * 0.15 +
    coverage * 0.1;

  return {
    shapeRecognition,
    wordDiversity,
    visualBalance: result.balanceScore,
    printQuality,
    typography,
    coverage,
    overall,
    uniqueWords: sourceUnique,
    duplicateWords: result.duplicateCount,
  };
}

function drawShapeOutline(
  ctx: CanvasRenderingContext2D,
  svg: string,
  width: number,
  height: number,
) {
  const viewBoxMatch = svg.match(/viewBox=["']([\d.\s-]+)["']/i);
  const [vbX, vbY, vbW, vbH] = (viewBoxMatch?.[1] || "0 0 1000 1000")
    .split(/\s+/)
    .map((n) => Number(n));
  const pathMatches = [...svg.matchAll(/<path[^>]*d=["']([^"']+)["'][^>]*>/gi)];
  if (pathMatches.length === 0) return;

  ctx.save();
  ctx.translate(0, 0);
  ctx.scale(width / vbW, height / vbH);
  ctx.translate(-vbX, -vbY);
  ctx.strokeStyle = "#0A0A0A";
  ctx.lineWidth = Math.max(10, Math.min(vbW, vbH) * 0.01);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const match of pathMatches) {
    ctx.stroke(new Path2D(match[1]));
  }
  ctx.restore();
}

/* ---------- UI primitives ---------- */

const inputCls =
  "w-full bg-input border border-panel-border px-2 py-1.5 text-sm text-foreground focus:border-amber-accent focus:outline-none focus:ring-0";

function Section({
  title,
  children,
  tinted,
}: {
  title: string;
  children: React.ReactNode;
  tinted?: boolean;
}) {
  return (
    <div className={`px-4 py-3 border-b border-panel-border ${tinted ? "" : ""}`}>
      <h3 className="label-mini mb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label-mini mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: (string | { value: string; label: string })[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls + " cursor-pointer"}
    >
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return (
          <option key={v} value={v} className="bg-input text-foreground">
            {l}
          </option>
        );
      })}
    </select>
  );
}

function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  valueLabel,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  valueLabel?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="label-mini">{label}</div>
        <div className="text-[10px] text-foreground tabular-nums">{valueLabel ?? value}</div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1"
        style={{ accentColor: "#D97706" }}
      />
    </div>
  );
}

function QualityRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-muted-foreground tracking-wider uppercase">{label}</span>
      <span className="tabular-nums font-semibold text-foreground">{Math.round(value)}</span>
    </div>
  );
}
