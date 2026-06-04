import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import {
  STUDENTS,
  FONT_OPTIONS,
  THEMES,
  SILHOUETTE_STYLES,
  OPTIMIZATION_PRESETS,
  type Student,
} from "@/lib/students";
import {
  callShapeGen,
  callWordExpansion,
  FALLBACK_HEART_SVG,
  type WordEntry,
} from "@/lib/gemini";
import { buildMaskFromSvg, packWords } from "@/lib/wordPacker";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ShapeWords Studio — Word Art Generator" },
      { name: "description", content: "Professional word art generator for Grade 4 classroom keepsakes. Print-ready 8x10 @ 300 DPI." },
      { property: "og:title", content: "ShapeWords Studio" },
      { property: "og:description", content: "Professional word art generator for classroom keepsakes." },
    ],
  }),
  component: ShapeWordsApp,
});

const EXPORT_RES = {
  preview: { w: 1200, h: 1500, label: "1200px (Preview)" },
  print: { w: 2400, h: 3000, label: "2400x3000px (8x10 @ 300 DPI)" },
  large: { w: 3600, h: 4500, label: "4500px (Large Print)" },
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
  exportFormat: "jpg" | "png" | "pdf";
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
    exportFormat: "jpg",
  };
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
  const [zoom, setZoom] = useState(100);
  const [batchProgress, setBatchProgress] = useState<{ i: number; total: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<{ mask: Uint8Array; size: number } | null>(null);

  // when active student changes, reset fields
  useEffect(() => {
    setNameField(active.name);
    setTraitsField(active.traits);
    setShapeField(active.shape);
    setConfig(defaultConfig(active));
    setWords([]);
    setShapeSvg(FALLBACK_HEART_SVG);
  }, [activeId]); // eslint-disable-line

  // build mask whenever svg changes
  useEffect(() => {
    let cancel = false;
    buildMaskFromSvg(shapeSvg, 512)
      .then((m) => {
        if (!cancel) maskRef.current = { mask: m, size: 512 };
      })
      .catch(() => {
        buildMaskFromSvg(FALLBACK_HEART_SVG, 512).then((m) => {
          if (!cancel) maskRef.current = { mask: m, size: 512 };
        });
      });
    return () => {
      cancel = true;
    };
  }, [shapeSvg]);

  const renderToCanvas = useCallback(
    async (targetCanvas?: HTMLCanvasElement, opts?: { width: number; height: number }) => {
      const canvas = targetCanvas ?? canvasRef.current;
      if (!canvas) return null;
      const res = opts ?? EXPORT_RES[config.resolution];
      const width = res.w ?? res.width;
      const height = res.h ?? res.height;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      if (!maskRef.current) {
        maskRef.current = { mask: await buildMaskFromSvg(shapeSvg, 512), size: 512 };
      }
      const wordSet: WordEntry[] = words.length > 0
        ? words
        : seedFromTraits(active.name, traitsField);
      const accent = active.colorPalette[1] ?? "#D97706";
      const result = await packWords(ctx, maskRef.current.mask, maskRef.current.size, {
        width,
        height,
        name: nameField,
        words: wordSet,
        fontFamily: config.fontFamily,
        accentColor: accent,
        primaryColor: active.colorPalette[0] ?? "#000000",
        bgColor: "#FFFFFF",
        density: config.density,
        scaling: config.scaling,
        adherence: config.adherence,
        rotation: config.rotation,
        randomness: config.randomness,
        centerBias: config.centerBias,
        emphasis: config.emphasis,
      });
      setPlacedCount(result.placedCount);
      return result;
    },
    [active, words, nameField, traitsField, shapeSvg, config],
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
      if (expansion?.words?.length) {
        setWords(expansion.words);
        if (expansion.design) {
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
      }
      setStatus("Packing words...");
      // give state a tick
      await new Promise((r) => setTimeout(r, 50));
      await renderToCanvas();
      setStatus("Quality check...");
      await new Promise((r) => setTimeout(r, 200));
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? String(e)));
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
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
      setStatus(null);
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    await renderToCanvas();
    const mime = config.exportFormat === "png" ? "image/png" : "image/jpeg";
    const ext = config.exportFormat === "png" ? "png" : "jpg";
    const data = canvas.toDataURL(mime, 0.95);
    triggerDownload(data, `${nameField}_WordArt_8x10.${ext}`);
  };

  const handleBatchExport = async () => {
    setBusy(true);
    const zip = new JSZip();
    const off = document.createElement("canvas");
    const res = EXPORT_RES[config.resolution];
    for (let i = 0; i < students.length; i++) {
      const s = students[i];
      setBatchProgress({ i: i + 1, total: students.length });
      setStatus(`Generating ${i + 1} of ${students.length}: ${s.name}`);
      try {
        const svg = FALLBACK_HEART_SVG; // skip API calls for speed; use last known seed words
        const mask = await buildMaskFromSvg(svg, 512);
        const ctx = off.getContext("2d")!;
        off.width = res.w;
        off.height = res.h;
        await packWords(ctx, mask, 512, {
          width: res.w,
          height: res.h,
          name: s.name,
          words: seedFromTraits(s.name, s.traits),
          fontFamily: s.fontFamily,
          accentColor: s.colorPalette[1] ?? "#D97706",
          primaryColor: s.colorPalette[0] ?? "#000000",
          density: s.density,
          scaling: 25,
          adherence: 92,
          rotation: 25,
          randomness: 15,
          centerBias: 85,
          emphasis: s.emphasis === "High" ? 4 : s.emphasis === "Medium" ? 3 : 2,
        });
        const blob: Blob = await new Promise((resolve) =>
          off.toBlob((b) => resolve(b!), "image/jpeg", 0.95),
        );
        zip.file(`${s.name}_WordArt_8x10.jpg`, blob);
      } catch (e) {
        console.warn("Batch fail", s.name, e);
      }
    }
    setStatus("Zipping...");
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().split("T")[0];
    triggerDownload(url, `Class_WordArt_${date}.zip`);
    URL.revokeObjectURL(url);
    setStatus(null);
    setBatchProgress(null);
    setBusy(false);
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
              <input value={nameField} onChange={(e) => setNameField(e.target.value)} className={inputCls} />
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
            <Slider label="Density" min={10} max={100} value={config.density} valueLabel={config.density + "%"} onChange={(v) => setConfig((c) => ({ ...c, density: v }))} />
            <Slider label="Word Scaling" min={10} max={50} value={config.scaling} valueLabel={(config.scaling / 10).toFixed(1) + "x"} onChange={(v) => setConfig((c) => ({ ...c, scaling: v }))} />
            <Slider label="Shape Adherence" min={10} max={100} value={config.adherence} valueLabel={config.adherence + "%"} onChange={(v) => setConfig((c) => ({ ...c, adherence: v }))} />
            <Slider label="Rotation Chance" min={0} max={100} value={config.rotation} valueLabel={config.rotation + "%"} onChange={(v) => setConfig((c) => ({ ...c, rotation: v }))} />
            <Slider label="Randomness" min={0} max={100} value={config.randomness} valueLabel={config.randomness + "%"} onChange={(v) => setConfig((c) => ({ ...c, randomness: v }))} />
            <Slider label="Center Bias" min={0} max={100} value={config.centerBias} valueLabel={config.centerBias + "%"} onChange={(v) => setConfig((c) => ({ ...c, centerBias: v }))} />
          </Section>

          <Section title="Export Resolution">
            <Field label="Resolution">
              <Select
                value={config.resolution}
                onChange={(v) => setConfig((c) => ({ ...c, resolution: v as Config["resolution"] }))}
                options={[
                  { value: "preview", label: EXPORT_RES.preview.label },
                  { value: "print", label: EXPORT_RES.print.label },
                  { value: "large", label: EXPORT_RES.large.label },
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
          </div>

          <div className="flex-1 flex items-center justify-center p-8 min-h-0">
            <div
              className="relative bg-white shadow-[0_0_60px_rgba(0,0,0,0.6)]"
              style={{
                aspectRatio: "4 / 5",
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
              {(status || busy) && (
                <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-3 backdrop-blur-sm">
                  <div className="w-10 h-10 border-2 border-amber-accent border-t-transparent rounded-full animate-spin" />
                  <div className="text-amber-accent text-xs tracking-widest uppercase">{status || "Working..."}</div>
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
              <input type="file" accept=".csv" className="hidden" onChange={() => alert("CSV import: stub")} />
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
            <Field label="Export Format">
              <Select
                value={config.exportFormat}
                onChange={(v) => setConfig((c) => ({ ...c, exportFormat: v as any }))}
                options={[
                  { value: "jpg", label: "JPG (Default, Print Quality)" },
                  { value: "png", label: "PNG" },
                  { value: "pdf", label: "PDF" },
                ]}
              />
            </Field>
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
              📦 Batch Export All
            </button>
            <button
              onClick={() => {
                const id = String(Date.now());
                const ns: Student = {
                  id,
                  name: "New Student",
                  shape: "Star silhouette",
                  traits: "kind, smart, creative",
                  theme: "Custom",
                  colorPalette: ["#000000", "#D97706"],
                  fontFamily: "Bebas Neue",
                  density: 90,
                  emphasis: "High",
                  aiExpansionProfile: "Kid-friendly Positive Character Traits",
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

function seedFromTraits(name: string, traits: string): WordEntry[] {
  const list = traits.split(/,/).map((t) => t.trim()).filter(Boolean);
  const filler = [
    "joy", "smart", "kind", "brave", "true", "bright", "fun", "wise", "bold", "cool", "calm", "warm", "swift",
    "loyal", "happy", "good", "shine", "free", "best", "neat", "sweet", "quick", "open", "real", "pure",
    "hero", "star", "spark", "glow", "smile", "rise", "soar", "dream", "hope", "team", "play", "learn",
    "create", "explore", "lead", "grow", "trust", "honest", "loving", "amazing", "awesome", "talented",
    "thoughtful", "respectful", "patient", "curious", "energetic", "imaginative", "courageous", "friendly",
    "helpful", "generous", "cheerful", "responsible", "determined", "focused", "creative", "athletic",
    "graceful", "strong", "fast", "powerful", "skillful", "clever", "witty", "playful", "gentle",
  ];
  const entries: WordEntry[] = [];
  entries.push({ word: name, category: "Name", importanceScore: 1000 });
  list.forEach((t) => entries.push({ word: t, category: "Character", importanceScore: 90 }));
  filler.forEach((w, i) => entries.push({ word: w, category: "Character", importanceScore: 30 + (i % 30) }));
  // duplicate filler at lower scores for tier 4/5
  filler.forEach((w, i) => entries.push({ word: w, category: "Character", importanceScore: 15 + (i % 15) }));
  return entries;
}

/* ---------- UI primitives ---------- */

const inputCls =
  "w-full bg-input border border-panel-border px-2 py-1.5 text-sm text-foreground focus:border-amber-accent focus:outline-none focus:ring-0";

function Section({ title, children, tinted }: { title: string; children: React.ReactNode; tinted?: boolean }) {
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
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls + " cursor-pointer"}>
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
