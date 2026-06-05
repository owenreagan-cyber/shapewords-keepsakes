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
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 32768,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const finish = data?.candidates?.[0]?.finishReason;
  if (!text) throw new Error(`Gemini returned no text (finishReason=${finish})`);
  return stripFences(text);
}

// Salvage parser: handles truncated JSON by closing arrays/objects mid-stream.
function parseExpansionLoose(text: string): ExpansionResponse | null {
  try {
    return JSON.parse(text) as ExpansionResponse;
  } catch {
    // Find "words":[ … and pull complete {...} entries.
    const wordsStart = text.indexOf('"words"');
    if (wordsStart < 0) return null;
    const arrStart = text.indexOf("[", wordsStart);
    if (arrStart < 0) return null;
    const words: WordEntry[] = [];
    let i = arrStart + 1;
    while (i < text.length) {
      // skip whitespace/commas
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (text[i] === "]" || i >= text.length) break;
      if (text[i] !== "{") break;
      // find matching closing brace
      let depth = 0;
      let j = i;
      let inStr = false;
      let esc = false;
      for (; j < text.length; j++) {
        const c = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) { j++; break; }
        }
      }
      if (depth !== 0) break; // incomplete trailing object
      const chunk = text.slice(i, j);
      try {
        const obj = JSON.parse(chunk) as WordEntry;
        if (obj && typeof obj.word === "string") words.push(obj);
      } catch {
        /* skip */
      }
      i = j;
    }
    if (words.length === 0) return null;
    return { words, design: {} as DesignSpec };
  }
}

const EXPANSION_SYSTEM = `You are creating end-of-year keepsake word art for a Grade 4 classroom (ages 9-10). Generate EXACTLY 180 school-appropriate positive words describing this student. Rules: (1) The student NAME must appear exactly ONCE with importanceScore: 1000. (2) Top 5-8 core traits: scores 85-100. (3) Supporting synonyms and related qualities: scores 40-80. (4) Filler micro-words: scores 10-35. (5) Categorize each word: Character | Leadership | Academics | Creativity | Athletics | Friendship | Interests. (6) Remove ALL: duplicates, appearance-based words, romantic language, anything inappropriate for a 9-year-old. (7) Focus expansion on the provided aiExpansionProfile. (8) Use SHORT single words (1-2 syllables when possible). (9) Return ONLY valid JSON, no markdown, no backticks.`;

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
  const parsed = parseExpansionLoose(text);
  if (!parsed || !parsed.words || parsed.words.length < 30) {
    throw new Error(`Gemini returned only ${parsed?.words?.length ?? 0} usable words`);
  }
  return parsed;
}


// Server-route-backed silhouette generation. Uses Lovable AI Gateway (gpt-image-2).
// Falls back to local deterministic SVGs when the route or gateway fails.
const SHAPE_CACHE_PREFIX = "lvbl_shape_v2:";

function getCachedShape(key: string): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    return sessionStorage.getItem(SHAPE_CACHE_PREFIX + key);
  } catch {
    return null;
  }
}
function setCachedShape(key: string, value: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(SHAPE_CACHE_PREFIX + key, value);
  } catch {
    /* quota */
  }
}

export async function callShapeGen(shapeDescription: string, style: string): Promise<string> {
  const deterministicShape = getDeterministicShapeSvg(shapeDescription);
  if (deterministicShape) return deterministicShape;

  const cacheKey = `${style}::${shapeDescription}`;
  const cached = getCachedShape(cacheKey);
  if (cached) return cached;

  const res = await fetch("/api/generate-silhouette", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shape: shapeDescription, style }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Silhouette route ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { dataUrl?: string };
  if (!data.dataUrl) throw new Error("Silhouette route returned no dataUrl");
  setCachedShape(cacheKey, data.dataUrl);
  return data.dataUrl;
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

const FALLBACK_MALE_DANCER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="470" cy="140" r="78" fill="#000"/>
  <ellipse cx="470" cy="352" rx="145" ry="208" fill="#000"/>
  <ellipse cx="255" cy="320" rx="188" ry="68" transform="rotate(-18 255 320)" fill="#000"/>
  <ellipse cx="706" cy="252" rx="196" ry="66" transform="rotate(34 706 252)" fill="#000"/>
  <ellipse cx="390" cy="708" rx="84" ry="230" transform="rotate(-20 390 708)" fill="#000"/>
  <ellipse cx="642" cy="650" rx="82" ry="250" transform="rotate(30 642 650)" fill="#000"/>
  <ellipse cx="742" cy="878" rx="112" ry="42" transform="rotate(12 742 878)" fill="#000"/>
</svg>`;

const FALLBACK_BALLET_DANCER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="512" cy="132" r="72" fill="#000"/>
  <ellipse cx="512" cy="312" rx="104" ry="160" fill="#000"/>
  <ellipse cx="520" cy="460" rx="225" ry="118" fill="#000"/>
  <ellipse cx="320" cy="292" rx="168" ry="48" transform="rotate(-26 320 292)" fill="#000"/>
  <ellipse cx="718" cy="292" rx="168" ry="48" transform="rotate(26 718 292)" fill="#000"/>
  <ellipse cx="426" cy="726" rx="56" ry="236" transform="rotate(-14 426 726)" fill="#000"/>
  <ellipse cx="598" cy="728" rx="56" ry="240" transform="rotate(12 598 728)" fill="#000"/>
  <ellipse cx="394" cy="922" rx="82" ry="30" fill="#000"/>
  <ellipse cx="624" cy="922" rx="82" ry="30" fill="#000"/>
</svg>`;

const FALLBACK_LEAPING_GIRL_DANCER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="560" cy="148" r="74" fill="#000"/>
  <ellipse cx="560" cy="338" rx="112" ry="168" fill="#000"/>
  <ellipse cx="352" cy="292" rx="166" ry="52" transform="rotate(-32 352 292)" fill="#000"/>
  <ellipse cx="756" cy="260" rx="186" ry="56" transform="rotate(24 756 260)" fill="#000"/>
  <ellipse cx="468" cy="684" rx="62" ry="236" transform="rotate(-30 468 684)" fill="#000"/>
  <ellipse cx="710" cy="620" rx="58" ry="266" transform="rotate(44 710 620)" fill="#000"/>
  <ellipse cx="866" cy="846" rx="76" ry="32" transform="rotate(32 866 846)" fill="#000"/>
</svg>`;

const FALLBACK_FEMALE_GYMNAST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="455" cy="190" r="74" fill="#000"/>
  <ellipse cx="500" cy="380" rx="192" ry="120" transform="rotate(-12 500 380)" fill="#000"/>
  <ellipse cx="290" cy="450" rx="188" ry="62" transform="rotate(-42 290 450)" fill="#000"/>
  <ellipse cx="725" cy="272" rx="176" ry="56" transform="rotate(24 725 272)" fill="#000"/>
  <ellipse cx="442" cy="665" rx="58" ry="256" transform="rotate(-58 442 665)" fill="#000"/>
  <ellipse cx="700" cy="690" rx="58" ry="232" transform="rotate(20 700 690)" fill="#000"/>
  <ellipse cx="290" cy="860" rx="84" ry="34" transform="rotate(-24 290 860)" fill="#000"/>
  <ellipse cx="782" cy="886" rx="86" ry="34" transform="rotate(10 782 886)" fill="#000"/>
</svg>`;

const FALLBACK_GIRL_SINGER_MICROPHONE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="470" cy="150" r="84" fill="#000"/>
  <ellipse cx="470" cy="390" rx="142" ry="214" fill="#000"/>
  <ellipse cx="282" cy="410" rx="144" ry="58" transform="rotate(-24 282 410)" fill="#000"/>
  <ellipse cx="640" cy="338" rx="184" ry="54" transform="rotate(18 640 338)" fill="#000"/>
  <ellipse cx="712" cy="284" rx="62" ry="46" fill="#000"/>
  <rect x="742" y="225" width="54" height="190" rx="24" fill="#000"/>
  <ellipse cx="802" cy="232" rx="58" ry="48" fill="#000"/>
  <ellipse cx="390" cy="712" rx="76" ry="222" transform="rotate(-12 390 712)" fill="#000"/>
  <ellipse cx="560" cy="714" rx="76" ry="222" transform="rotate(14 560 714)" fill="#000"/>
  <ellipse cx="350" cy="920" rx="92" ry="36" fill="#000"/>
  <ellipse cx="610" cy="920" rx="92" ry="36" fill="#000"/>
</svg>`;

const FALLBACK_BASEBALL_BATTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="430" cy="164" r="80" fill="#000"/>
  <ellipse cx="440" cy="378" rx="148" ry="214" fill="#000"/>
  <ellipse cx="268" cy="356" rx="172" ry="62" transform="rotate(-20 268 356)" fill="#000"/>
  <ellipse cx="620" cy="286" rx="198" ry="54" transform="rotate(-36 620 286)" fill="#000"/>
  <rect x="680" y="70" width="74" height="380" rx="34" transform="rotate(-32 717 260)" fill="#000"/>
  <ellipse cx="380" cy="714" rx="84" ry="232" transform="rotate(-14 380 714)" fill="#000"/>
  <ellipse cx="562" cy="716" rx="86" ry="228" transform="rotate(18 562 716)" fill="#000"/>
  <ellipse cx="340" cy="926" rx="96" ry="34" fill="#000"/>
  <ellipse cx="624" cy="926" rx="96" ry="34" fill="#000"/>
</svg>`;

const FALLBACK_FOOTBALL_QB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="510" cy="158" r="82" fill="#000"/>
  <ellipse cx="510" cy="386" rx="162" ry="220" fill="#000"/>
  <ellipse cx="338" cy="392" rx="148" ry="62" transform="rotate(-18 338 392)" fill="#000"/>
  <ellipse cx="694" cy="336" rx="194" ry="58" transform="rotate(22 694 336)" fill="#000"/>
  <ellipse cx="770" cy="314" rx="72" ry="48" transform="rotate(20 770 314)" fill="#000"/>
  <ellipse cx="438" cy="714" rx="86" ry="226" transform="rotate(-8 438 714)" fill="#000"/>
  <ellipse cx="622" cy="710" rx="86" ry="232" transform="rotate(20 622 710)" fill="#000"/>
  <ellipse cx="412" cy="924" rx="98" ry="36" fill="#000"/>
  <ellipse cx="672" cy="924" rx="98" ry="36" fill="#000"/>
</svg>`;

const FALLBACK_SOCCER_KICKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="450" cy="150" r="78" fill="#000"/>
  <ellipse cx="460" cy="368" rx="148" ry="206" fill="#000"/>
  <ellipse cx="286" cy="342" rx="168" ry="58" transform="rotate(-22 286 342)" fill="#000"/>
  <ellipse cx="664" cy="320" rx="170" ry="56" transform="rotate(16 664 320)" fill="#000"/>
  <ellipse cx="392" cy="716" rx="84" ry="228" transform="rotate(-14 392 716)" fill="#000"/>
  <ellipse cx="678" cy="666" rx="68" ry="264" transform="rotate(38 678 666)" fill="#000"/>
  <ellipse cx="844" cy="882" rx="76" ry="34" transform="rotate(20 844 882)" fill="#000"/>
  <circle cx="920" cy="846" r="66" fill="#000"/>
</svg>`;

const FALLBACK_SOCCER_GOALIE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="520" cy="164" r="80" fill="#000"/>
  <ellipse cx="520" cy="392" rx="168" ry="214" fill="#000"/>
  <ellipse cx="292" cy="308" rx="206" ry="62" transform="rotate(-28 292 308)" fill="#000"/>
  <ellipse cx="748" cy="324" rx="206" ry="62" transform="rotate(28 748 324)" fill="#000"/>
  <ellipse cx="430" cy="716" rx="84" ry="226" transform="rotate(-10 430 716)" fill="#000"/>
  <ellipse cx="606" cy="710" rx="84" ry="232" transform="rotate(16 606 710)" fill="#000"/>
  <circle cx="884" cy="220" r="68" fill="#000"/>
  <ellipse cx="392" cy="926" rx="96" ry="34" fill="#000"/>
  <ellipse cx="654" cy="926" rx="96" ry="34" fill="#000"/>
</svg>`;

const FALLBACK_ICE_HOCKEY_PLAYER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <circle cx="460" cy="170" r="78" fill="#000"/>
  <ellipse cx="468" cy="396" rx="154" ry="216" fill="#000"/>
  <ellipse cx="306" cy="420" rx="170" ry="58" transform="rotate(-24 306 420)" fill="#000"/>
  <ellipse cx="640" cy="408" rx="168" ry="58" transform="rotate(24 640 408)" fill="#000"/>
  <rect x="712" y="266" width="58" height="474" rx="26" transform="rotate(22 741 503)" fill="#000"/>
  <ellipse cx="394" cy="726" rx="84" ry="224" transform="rotate(-12 394 726)" fill="#000"/>
  <ellipse cx="582" cy="728" rx="84" ry="228" transform="rotate(16 582 728)" fill="#000"/>
  <rect x="282" y="900" width="420" height="42" rx="18" fill="#000"/>
</svg>`;

// Chunky front-facing teddy bear: head with rounded ears + muzzle, body, arms hanging
// at sides, legs with paws. Designed for word-packing fill (big interior area).
const FALLBACK_BEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <!-- Ears (outer + inner kept solid for silhouette) -->
  <circle cx="280" cy="190" r="115" fill="#000"/>
  <circle cx="720" cy="190" r="115" fill="#000"/>
  <!-- Head -->
  <ellipse cx="500" cy="290" rx="245" ry="215" fill="#000"/>
  <!-- Muzzle bulge (keeps silhouette readable as a bear face) -->
  <ellipse cx="500" cy="370" rx="150" ry="105" fill="#000"/>
  <!-- Neck wedge -->
  <rect x="430" y="450" width="140" height="80" fill="#000"/>
  <!-- Body (rounded, wide for word packing) -->
  <ellipse cx="500" cy="690" rx="305" ry="270" fill="#000"/>
  <!-- Arms hanging at sides -->
  <ellipse cx="215" cy="640" rx="105" ry="180" fill="#000"/>
  <ellipse cx="785" cy="640" rx="105" ry="180" fill="#000"/>
  <!-- Paws on arms -->
  <circle cx="215" cy="820" r="92" fill="#000"/>
  <circle cx="785" cy="820" r="92" fill="#000"/>
  <!-- Feet -->
  <ellipse cx="370" cy="930" rx="130" ry="62" fill="#000"/>
  <ellipse cx="630" cy="930" rx="130" ry="62" fill="#000"/>
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

const SHAPE_SVG_RULES: Array<{ pattern: RegExp; svg: string; deterministic: boolean }> = [
  { pattern: /(teddy|red panda|bear)/, svg: FALLBACK_BEAR_SVG, deterministic: false },
  {
    pattern: /(graceful.*dancer.*leaping|girl leaping in dance|leaping in dance)/,
    svg: FALLBACK_LEAPING_GIRL_DANCER_SVG,
    deterministic: true,
  },
  {
    pattern: /(cheerleader|pom-?pom|pom pom|cheer)/,
    svg: FALLBACK_CHEERLEADER_SVG,
    deterministic: true,
  },
  {
    pattern: /(boy dancing|male dancer|cool .*boy .*dancing)/,
    svg: FALLBACK_MALE_DANCER_SVG,
    deterministic: true,
  },
  { pattern: /(ballet)/, svg: FALLBACK_BALLET_DANCER_SVG, deterministic: true },
  {
    pattern: /(gymnastics|gymnast|tumbling)/,
    svg: FALLBACK_FEMALE_GYMNAST_SVG,
    deterministic: true,
  },
  {
    pattern: /(singing.*microphone|microphone|singer)/,
    svg: FALLBACK_GIRL_SINGER_MICROPHONE_SVG,
    deterministic: true,
  },
  {
    pattern: /(baseball.*bat|swinging.*baseball|baseball batter)/,
    svg: FALLBACK_BASEBALL_BATTER_SVG,
    deterministic: true,
  },
  {
    pattern: /(throwing.*football|quarterback|football throw)/,
    svg: FALLBACK_FOOTBALL_QB_SVG,
    deterministic: true,
  },
  {
    pattern: /(kicking.*soccer|soccer.*kicking|soccer kick)/,
    svg: FALLBACK_SOCCER_KICKER_SVG,
    deterministic: true,
  },
  {
    pattern: /(goalie|saving.*soccer|goalie net|goal keeper)/,
    svg: FALLBACK_SOCCER_GOALIE_SVG,
    deterministic: true,
  },
  {
    pattern: /(ice hockey|hockey player|playing ice hockey|hockey)/,
    svg: FALLBACK_ICE_HOCKEY_PLAYER_SVG,
    deterministic: true,
  },
  { pattern: /(eagle|bird|wing|flying)/, svg: FALLBACK_BIRD_SVG, deterministic: true },
  {
    pattern: /(dog|horse|gallop|cat|fox|wolf|panda)/,
    svg: FALLBACK_ANIMAL_SVG,
    deterministic: true,
  },
  { pattern: /(snake|serpent)/, svg: FALLBACK_SNAKE_SVG, deterministic: true },
  {
    pattern: /(game controller|controller|gamepad|video game)/,
    svg: FALLBACK_CONTROLLER_SVG,
    deterministic: true,
  },
  { pattern: /(lightning|bolt)/, svg: FALLBACK_LIGHTNING_SVG, deterministic: true },
  { pattern: /(robot|gear|engineering)/, svg: FALLBACK_GEAR_SVG, deterministic: true },
  { pattern: /(laptop|computer)/, svg: FALLBACK_LAPTOP_SVG, deterministic: true },
  { pattern: /(helmet)/, svg: FALLBACK_HELMET_SVG, deterministic: true },
  { pattern: /(ribbon|medal|award)/, svg: FALLBACK_RIBBON_SVG, deterministic: true },
  { pattern: /(pixel|blocky|character)/, svg: FALLBACK_PIXEL_CHARACTER_SVG, deterministic: true },
  {
    pattern:
      /(boy|girl|dancer|dance|gymnast|cheer|sing|microphone|baseball|football|soccer|goalie|hockey|jump|kick|throw|tumbling|leaping)/,
    svg: FALLBACK_HUMAN_SVG,
    deterministic: false,
  },
];

function getShapeSvgFromRules(shapeDescription: string, deterministicOnly: boolean): string | null {
  const normalized = shapeDescription.toLowerCase();
  for (const rule of SHAPE_SVG_RULES) {
    if (deterministicOnly && !rule.deterministic) continue;
    if (rule.pattern.test(normalized)) return rule.svg;
  }
  return null;
}

function getDeterministicShapeSvg(shapeDescription: string): string | null {
  return getShapeSvgFromRules(shapeDescription, true);
}

export function getFallbackShapeSvg(shapeDescription: string): string {
  return getShapeSvgFromRules(shapeDescription, false) ?? FALLBACK_STAR_SVG;
}
