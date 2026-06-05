// Direct browser-side Gemini calls. API key from VITE_GEMINI_API_KEY.

export interface WordEntry {
  word: string;
  category: string;
  importanceScore: number;
}

export interface DesignSpec {
  fontFamily: string;
  accentColor: string;
  density: number;
  scaling: number;
  adherence: number;
  centerBias: number;
  rotation: number;
  randomness: number;
}

export interface ExpansionResponse {
  words: WordEntry[];
  design: DesignSpec;
}

const API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

function getKey(): string {
  const k = import.meta.env?.VITE_GEMINI_API_KEY;
  if (!k) throw new Error("Missing VITE_GEMINI_API_KEY in environment");
  return k;
}

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json|svg|xml)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function callGemini(systemInstruction: string, userPrompt: string): Promise<string> {
  const res = await fetch(`${API_BASE}?key=${getKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  return stripFences(text);
}

const EXPANSION_SYSTEM = `You are creating end-of-year keepsake word art for a Grade 4 classroom (ages 9-10). Generate 300-500 school-appropriate positive words describing this student. Rules: (1) The student NAME must appear exactly ONCE with importanceScore: 1000. (2) Top 5-8 core traits: scores 85-100. (3) Supporting synonyms and related qualities: scores 40-80. (4) Filler micro-words: scores 10-35. (5) Categorize each word: Character | Leadership | Academics | Creativity | Athletics | Friendship | Interests. (6) Remove ALL: duplicates, appearance-based words, romantic language, anything inappropriate for a 9-year-old. (7) Focus expansion on the provided aiExpansionProfile. (8) Return ONLY valid JSON, no markdown, no backticks.`;

export async function callWordExpansion(args: {
  name: string;
  traits: string;
  theme?: string;
  aiExpansionProfile: string;
  preset: string;
  fontFamily: string;
  accentColor: string;
}): Promise<ExpansionResponse> {
  const prompt = `Student Name: ${args.name}
Core traits: ${args.traits}
Theme: ${args.theme || "Not specified"}
aiExpansionProfile: ${args.aiExpansionProfile}
Optimization Preset: ${args.preset}
Preferred fontFamily: ${args.fontFamily}
Preferred accentColor: ${args.accentColor}

Return ONLY JSON matching:
{"words":[{"word":string,"category":string,"importanceScore":number}], "design":{"fontFamily":string,"accentColor":string,"density":number,"scaling":number,"adherence":number,"centerBias":number,"rotation":number,"randomness":number}}`;
  const text = await callGemini(EXPANSION_SYSTEM, prompt);
  const parsed = JSON.parse(text);
  return parsed as ExpansionResponse;
}

// Image-generation endpoint (Nano Banana). Returns a PNG silhouette as a data URL.
const IMAGE_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent";

export async function callShapeGen(shapeDescription: string, style: string): Promise<string> {
  const deterministicShape = getDeterministicShapeSvg(shapeDescription);
  if (deterministicShape) return deterministicShape;

  const prompt = `A bold, solid pure-black silhouette of: ${shapeDescription}.
Style reference: ${style}.
Strict requirements:
- Pure white (#FFFFFF) background, edge to edge.
- The subject is a single solid black (#000000) silhouette only — no outlines, no shading, no gradients, no patterns, no text, no watermark, no border.
- Iconic, instantly recognizable pose for ${shapeDescription}; preserve characteristic features (ears, limbs, accessories).
- Chunky, thickened, plush-toy proportions so the silhouette has lots of internal area; no thin spindly parts.
- The silhouette is centered and fills approximately 80% of a square 1:1 frame.
- Crisp, clean edges. Flat 2D vector-look. No 3D rendering, no photography.`;

  const res = await fetch(`${IMAGE_API_BASE}?key=${getKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  if (!res.ok) throw new Error(`Gemini image ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = p?.inlineData ?? p?.inline_data;
    if (inline?.data) {
      const mime = inline.mimeType || inline.mime_type || "image/png";
      return `data:${mime};base64,${inline.data}`;
    }
  }
  throw new Error("Gemini image returned no inline image data");
}

// Fallback heart shape
export const FALLBACK_HEART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M500 880 C 200 680 60 480 60 320 C 60 180 170 80 290 80 C 380 80 450 130 500 220 C 550 130 620 80 710 80 C 830 80 940 180 940 320 C 940 480 800 680 500 880 Z"/></svg>`;

const FALLBACK_HUMAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="500" cy="130" r="95" fill="#000"/>
  <ellipse cx="500" cy="390" rx="180" ry="220" fill="#000"/>
  <ellipse cx="240" cy="300" rx="190" ry="70" transform="rotate(-22 240 300)" fill="#000"/>
  <ellipse cx="760" cy="300" rx="190" ry="70" transform="rotate(22 760 300)" fill="#000"/>
  <ellipse cx="360" cy="690" rx="78" ry="215" transform="rotate(-25 360 690)" fill="#000"/>
  <ellipse cx="640" cy="690" rx="78" ry="215" transform="rotate(25 640 690)" fill="#000"/>
</svg>`;

const FALLBACK_DANCER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="545" cy="145" r="82" fill="#000"/>
  <ellipse cx="545" cy="355" rx="128" ry="195" fill="#000"/>
  <ellipse cx="300" cy="290" rx="180" ry="58" transform="rotate(-26 300 290)" fill="#000"/>
  <ellipse cx="760" cy="292" rx="175" ry="56" transform="rotate(27 760 292)" fill="#000"/>
  <ellipse cx="430" cy="648" rx="62" ry="220" transform="rotate(-34 430 648)" fill="#000"/>
  <ellipse cx="690" cy="664" rx="64" ry="224" transform="rotate(28 690 664)" fill="#000"/>
  <ellipse cx="758" cy="874" rx="92" ry="38" transform="rotate(14 758 874)" fill="#000"/>
</svg>`;

const FALLBACK_CHEERLEADER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="500" cy="150" r="86" fill="#000"/>
  <ellipse cx="500" cy="375" rx="132" ry="208" fill="#000"/>
  <ellipse cx="262" cy="326" rx="160" ry="64" transform="rotate(-12 262 326)" fill="#000"/>
  <ellipse cx="738" cy="326" rx="160" ry="64" transform="rotate(12 738 326)" fill="#000"/>
  <circle cx="145" cy="335" r="96" fill="#000"/>
  <circle cx="855" cy="335" r="96" fill="#000"/>
  <ellipse cx="410" cy="694" rx="72" ry="212" transform="rotate(-17 410 694)" fill="#000"/>
  <ellipse cx="590" cy="694" rx="72" ry="212" transform="rotate(17 590 694)" fill="#000"/>
  <ellipse cx="360" cy="900" rx="96" ry="42" fill="#000"/>
  <ellipse cx="640" cy="900" rx="96" ry="42" fill="#000"/>
</svg>`;

const FALLBACK_BEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="320" cy="220" r="90" fill="#000"/>
  <circle cx="680" cy="220" r="90" fill="#000"/>
  <circle cx="500" cy="340" r="240" fill="#000"/>
  <ellipse cx="500" cy="700" rx="280" ry="230" fill="#000"/>
  <circle cx="320" cy="710" r="110" fill="#000"/>
  <circle cx="680" cy="710" r="110" fill="#000"/>
</svg>`;

const FALLBACK_ANIMAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <ellipse cx="520" cy="520" rx="330" ry="210" fill="#000"/>
  <ellipse cx="760" cy="430" rx="150" ry="120" fill="#000"/>
  <ellipse cx="220" cy="470" rx="120" ry="85" fill="#000"/>
  <rect x="280" y="610" width="90" height="210" rx="35" fill="#000"/>
  <rect x="430" y="630" width="90" height="220" rx="35" fill="#000"/>
  <rect x="590" y="630" width="90" height="220" rx="35" fill="#000"/>
  <rect x="740" y="610" width="90" height="210" rx="35" fill="#000"/>
</svg>`;

const FALLBACK_BIRD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <path fill="#000" d="M90 540 C 260 420 430 390 560 430 C 690 470 790 560 920 620 C 760 640 650 700 540 780 C 450 720 360 690 250 670 C 200 620 150 580 90 540 Z"/>
  <ellipse cx="640" cy="500" rx="170" ry="120" fill="#000"/>
  <path fill="#000" d="M630 390 L760 250 L780 410 Z"/>
</svg>`;

const FALLBACK_SNAKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <path fill="#000" d="M110 690 C 230 520 380 500 490 600 C 610 710 740 700 860 550 C 890 510 940 520 960 560 C 980 600 960 650 930 690 C 780 900 530 910 370 760 C 300 690 230 700 170 790 Z"/>
  <circle cx="885" cy="520" r="62" fill="#000"/>
</svg>`;

const FALLBACK_CONTROLLER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <rect x="130" y="320" width="740" height="360" rx="170" fill="#000"/>
  <rect x="250" y="430" width="180" height="50" rx="20" fill="#fff"/>
  <rect x="315" y="365" width="50" height="180" rx="20" fill="#fff"/>
  <circle cx="660" cy="450" r="40" fill="#fff"/>
  <circle cx="740" cy="520" r="40" fill="#fff"/>
</svg>`;

const FALLBACK_LIGHTNING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <path fill="#000" d="M560 70 L210 560 H430 L330 930 L790 410 H560 Z"/>
</svg>`;

const FALLBACK_GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="500" cy="500" r="280" fill="#000"/>
  <circle cx="500" cy="500" r="110" fill="#fff"/>
  <rect x="450" y="40" width="100" height="140" rx="20" fill="#000"/>
  <rect x="450" y="820" width="100" height="140" rx="20" fill="#000"/>
  <rect x="820" y="450" width="140" height="100" rx="20" fill="#000"/>
  <rect x="40" y="450" width="140" height="100" rx="20" fill="#000"/>
  <rect x="724" y="144" width="120" height="100" rx="20" transform="rotate(35 784 194)" fill="#000"/>
  <rect x="156" y="756" width="120" height="100" rx="20" transform="rotate(35 216 806)" fill="#000"/>
  <rect x="724" y="756" width="120" height="100" rx="20" transform="rotate(-35 784 806)" fill="#000"/>
  <rect x="156" y="144" width="120" height="100" rx="20" transform="rotate(-35 216 194)" fill="#000"/>
</svg>`;

const FALLBACK_LAPTOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <rect x="240" y="170" width="520" height="420" rx="32" fill="#000"/>
  <rect x="130" y="620" width="740" height="130" rx="40" fill="#000"/>
</svg>`;

const FALLBACK_HELMET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <path fill="#000" d="M120 610 C 120 340 320 170 560 170 C 760 170 900 300 900 490 C 900 650 790 770 620 770 H200 C 155 770 120 735 120 690 Z"/>
  <rect x="180" y="560" width="520" height="90" rx="20" fill="#fff"/>
  <rect x="700" y="560" width="180" height="90" rx="20" fill="#000"/>
</svg>`;

const FALLBACK_RIBBON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="500" cy="330" r="220" fill="#000"/>
  <path fill="#000" d="M350 520 L470 920 L580 760 L690 920 L760 520 Z"/>
</svg>`;

const FALLBACK_PIXEL_CHARACTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <rect x="250" y="150" width="500" height="500" fill="#000"/>
  <rect x="330" y="670" width="120" height="200" fill="#000"/>
  <rect x="550" y="670" width="120" height="200" fill="#000"/>
</svg>`;

const FALLBACK_STAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <path fill="#000" d="M500 80 L610 360 L920 380 L680 560 L760 870 L500 700 L240 870 L320 560 L80 380 L390 360 Z"/>
</svg>`;

function getDeterministicShapeSvg(shapeDescription: string): string | null {
  const normalized = shapeDescription.toLowerCase();
  if (/(teddy|red panda|bear)/.test(normalized)) return FALLBACK_BEAR_SVG;
  if (/(cheerleader|pom-?pom|pom pom|cheer)/.test(normalized)) return FALLBACK_CHEERLEADER_SVG;
  if (/(dancer|dance|ballet|gymnast|tumbling|leaping)/.test(normalized)) return FALLBACK_DANCER_SVG;
  if (/(game controller|controller|gamepad|video game)/.test(normalized))
    return FALLBACK_CONTROLLER_SVG;
  if (/(helmet)/.test(normalized)) return FALLBACK_HELMET_SVG;
  return null;
}

export function getFallbackShapeSvg(shapeDescription: string): string {
  const normalized = shapeDescription.toLowerCase();

  if (/(teddy|red panda|bear)/.test(normalized)) return FALLBACK_BEAR_SVG;
  if (/(cheerleader|pom-?pom|pom pom|cheer)/.test(normalized)) return FALLBACK_CHEERLEADER_SVG;
  if (/(dancer|dance|ballet|gymnast|tumbling|leaping)/.test(normalized)) return FALLBACK_DANCER_SVG;
  if (/(eagle|bird|wing|flying)/.test(normalized)) return FALLBACK_BIRD_SVG;
  if (/(dog|horse|gallop|cat|fox|wolf|panda)/.test(normalized)) return FALLBACK_ANIMAL_SVG;
  if (/(snake|serpent)/.test(normalized)) return FALLBACK_SNAKE_SVG;
  if (/(game controller|controller|gamepad|video game)/.test(normalized))
    return FALLBACK_CONTROLLER_SVG;
  if (/(lightning|bolt)/.test(normalized)) return FALLBACK_LIGHTNING_SVG;
  if (/(robot|gear|engineering)/.test(normalized)) return FALLBACK_GEAR_SVG;
  if (/(laptop|computer)/.test(normalized)) return FALLBACK_LAPTOP_SVG;
  if (/(helmet)/.test(normalized)) return FALLBACK_HELMET_SVG;
  if (/(ribbon|medal|award)/.test(normalized)) return FALLBACK_RIBBON_SVG;
  if (/(pixel|blocky|character)/.test(normalized)) return FALLBACK_PIXEL_CHARACTER_SVG;
  if (
    /(boy|girl|dancer|dance|ballet|gymnast|cheer|sing|microphone|baseball|football|soccer|goalie|hockey|jump|kick|throw|tumbling|leaping)/.test(
      normalized,
    )
  ) {
    return FALLBACK_HUMAN_SVG;
  }
  return FALLBACK_STAR_SVG;
}
