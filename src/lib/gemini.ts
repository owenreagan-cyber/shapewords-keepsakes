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
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

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
  aiExpansionProfile: string;
  preset: string;
  fontFamily: string;
  accentColor: string;
}): Promise<ExpansionResponse> {
  const prompt = `Student Name: ${args.name}
Core traits: ${args.traits}
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

export async function callShapeGen(shapeDescription: string, style: string): Promise<string> {
  const sys = `You are an expert SVG designer creating BOLD, MASSIVE silhouettes for word-art alpha masks. Subject: ${shapeDescription}. Style: ${style}.

CRITICAL RULES:
(1) Output ONLY valid SVG, no markdown, no explanation, no backticks.
(2) viewBox='0 0 1000 1000'.
(3) Single solid black fill #000000, no strokes, no gradients, no outlines, no background element.
(4) MAXIMUM BOLDNESS AND MASS — the silhouette MUST fill AT LEAST 75% of the viewBox area with solid black. This is a HARD requirement: thin limbs, narrow tails, and skinny appendages MUST be thickened dramatically (2-4x their natural proportion) so words can fit inside them. Better to look chunky and chubby than thin and elegant.
(5) Inflate every body part: thicken legs, widen arms, fatten torsos, bulk up heads. Think "plush toy" or "balloon animal" proportions, not realistic anatomy.
(6) Preserve and EXAGGERATE iconic landmarks (ears, action pose, characteristic features) so the silhouette is recognizable from 10 feet away.
(7) Use <path> elements with smooth bold curves. Merge small disconnected parts into the main mass when possible.
(8) The shape should nearly touch the viewBox edges on at least two sides — push it large, do not leave generous padding.
(9) Self-check before output: would this silhouette, if filled solid black, cover roughly three-quarters of a 1000x1000 square? If not, make it bigger and thicker.`;
  const text = await callGemini(
    sys,
    `Generate the BOLD, MASSIVE SVG silhouette now for: ${shapeDescription}. Remember: minimum 75% viewBox fill, inflated proportions, no thin parts.`,
  );
  const m = text.match(/<svg[\s\S]*<\/svg>/i);
  return m ? m[0] : text;
}

// Fallback heart shape
export const FALLBACK_HEART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M500 880 C 200 680 60 480 60 320 C 60 180 170 80 290 80 C 380 80 450 130 500 220 C 550 130 620 80 710 80 C 830 80 940 180 940 320 C 940 480 800 680 500 880 Z"/></svg>`;
