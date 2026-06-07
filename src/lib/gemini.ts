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
          if (depth === 0) {
            j++;
            break;
          }
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

const EXPANSION_SYSTEM = `You are creating end-of-year keepsake word art for a Grade 4 classroom (ages 9-10). Generate EXACTLY 350 school-appropriate positive words describing this student. Rules: (1) The student NAME must appear exactly ONCE with importanceScore: 1000. (2) Top 5-8 core traits: scores 85-100. (3) Supporting synonyms and related qualities: scores 40-80. (4) Filler micro-words: scores 10-35. (5) Categorize each word: Character | Leadership | Academics | Creativity | Athletics | Friendship | Interests. (6) Remove ALL: duplicates, appearance-based words, romantic language, anything inappropriate for a 9-year-old. (7) Focus expansion on the provided aiExpansionProfile. (8) Use SHORT single words (1-2 syllables when possible). (9) Return ONLY valid JSON, no markdown, no backticks.`;

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
  if (!parsed || !parsed.words || parsed.words.length < 80) {
    throw new Error(`Gemini returned only ${parsed?.words?.length ?? 0} usable words`);
  }
  parsed.words = sanitizeWords(parsed.words, args.name);
  return parsed;
}

// School-appropriate filter: drops appearance / romantic / age-inappropriate words.
const BANNED_EXACT = new Set<string>([
  "cute",
  "beautiful",
  "sexy",
  "hot",
  "pretty",
  "gorgeous",
  "attractive",
  "handsome",
  "adorable",
  "lovely",
  "stunning",
  "ugly",
  "fat",
  "skinny",
  "thin",
  "slim",
  "tall",
  "short",
  "love",
  "loves",
  "crush",
  "kiss",
  "kissing",
  "date",
  "dating",
  "boyfriend",
  "girlfriend",
  "hate",
  "hates",
  "stupid",
  "dumb",
  "idiot",
  "loser",
  "mean",
  "cruel",
  "bossy",
  "babe",
  "baby",
  "hottie",
  "cool-looking",
  "fit",
  "muscular",
  "busty",
  "curvy",
  "slender",
]);
const BANNED_ROOTS = ["sexi", "kiss", "crush", "babe", "hottie", "muscle", "model-like"];

export function sanitizeWords<T extends { word: string }>(entries: T[], keepName?: string): T[] {
  const keep = (keepName || "").toLowerCase();
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of entries) {
    const w = (e.word || "").trim().toLowerCase();
    if (!w) continue;
    if (w === keep) {
      if (!seen.has(w)) {
        seen.add(w);
        out.push(e);
      }
      continue;
    }
    if (BANNED_EXACT.has(w)) continue;
    if (BANNED_ROOTS.some((r) => w.includes(r))) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(e);
  }
  return out;
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
  const cleaned = await thresholdImageMask(data.dataUrl);
  setCachedShape(cacheKey, cleaned);
  return cleaned;
}

/**
 * Takes a PNG data URL from GPT-Image-2 and returns a cleaned version
 * where every pixel is either pure black (>=50% dark) or pure white.
 * This eliminates gray anti-aliasing that corrupts mask quality.
 */
export async function thresholdImageMask(dataUrl: string): Promise<string> {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    return dataUrl;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }

      // White background first
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255);
        const isShape = luminance < 102;
        data[i] = isShape ? 0 : 255;
        data[i + 1] = isShape ? 0 : 255;
        data[i + 2] = isShape ? 0 : 255;
        data[i + 3] = 255;
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL("image/png", 1.0));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Fallback heart shape
export const FALLBACK_HEART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M500 880 C 200 680 60 480 60 320 C 60 180 170 80 290 80 C 380 80 450 130 500 220 C 550 130 620 80 710 80 C 830 80 940 180 940 320 C 940 480 800 680 500 880 Z"/></svg>`;

const FALLBACK_HUMAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M500 55 C 560 55 610 105 610 165 C 610 205 588 241 555 260 C 635 280 700 330 735 405 L 900 375 C 928 370 955 390 955 420 C 955 445 935 468 910 473 L 770 502 C 773 520 775 540 775 560 C 775 598 752 630 716 646 L 642 680 C 668 735 690 805 705 888 C 710 918 685 945 655 940 C 628 935 610 912 610 886 C 605 820 595 768 578 725 C 553 741 527 750 500 750 C 473 750 447 741 422 725 C 405 768 395 820 390 886 C 390 912 372 935 345 940 C 315 945 290 918 295 888 C 310 805 332 735 358 680 L 284 646 C 248 630 225 598 225 560 C 225 540 227 520 230 502 L 90 473 C 65 468 45 445 45 420 C 45 390 72 370 100 375 L 265 405 C 300 330 365 280 445 260 C 412 241 390 205 390 165 C 390 105 440 55 500 55 Z"/></svg>`;

const FALLBACK_DANCER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M555 70 C 610 70 655 115 655 170 C 655 205 637 236 610 255 C 650 265 684 288 710 320 L 890 252 C 918 242 947 260 952 290 C 956 316 940 340 915 350 L 750 415 C 770 455 780 500 780 548 C 780 586 756 620 720 635 L 650 664 C 680 742 726 820 795 900 C 812 920 810 950 790 965 C 768 980 737 975 720 955 C 645 870 585 785 540 700 C 512 715 483 720 455 714 L 360 892 C 345 920 313 930 285 914 C 260 898 252 867 266 842 L 350 678 C 316 658 290 626 282 586 L 180 622 C 152 632 123 616 118 586 C 114 560 130 536 155 526 L 272 484 C 274 426 294 372 330 328 C 360 292 402 268 448 260 C 416 242 395 207 395 170 C 395 115 440 70 495 70 C 518 70 538 78 555 92 Z"/></svg>`;

const FALLBACK_CHEERLEADER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M500 60 C 555 60 595 100 595 160 C 595 195 580 222 558 240 C 600 232 640 220 680 200 C 740 170 800 130 860 100 C 890 86 920 110 915 145 C 905 210 850 270 780 305 C 720 335 660 350 600 360 C 660 380 700 430 720 500 C 735 560 730 620 705 670 C 690 700 660 715 630 705 C 615 700 605 690 600 678 C 605 720 600 760 580 790 C 560 820 540 822 525 760 C 515 720 515 680 520 640 C 480 645 440 645 400 640 C 405 680 405 720 395 760 C 380 822 360 820 340 790 C 320 760 315 720 320 678 C 315 690 305 700 290 705 C 260 715 230 700 215 670 C 190 620 185 560 200 500 C 220 430 260 380 320 360 C 260 350 200 335 140 305 C 70 270 15 210 5 145 C 0 110 30 86 60 100 C 120 130 180 170 240 200 C 280 220 320 232 362 240 C 340 222 325 195 325 160 C 325 100 365 60 420 60 C 445 60 470 65 490 75 Z"/></svg>`;

const FALLBACK_MALE_DANCER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M470 70 C 523 70 565 112 565 165 C 565 198 549 227 524 246 C 572 258 614 286 646 326 L 860 212 C 888 197 922 207 938 236 C 952 264 941 297 914 312 L 710 422 C 732 462 745 510 745 560 C 745 598 722 632 686 648 L 618 678 C 650 760 710 834 805 900 C 832 918 838 954 818 978 C 798 1000 764 1006 739 987 C 629 905 551 816 505 720 C 486 725 466 726 447 724 L 408 880 C 400 912 368 934 336 925 C 304 916 284 884 292 852 L 330 699 C 305 683 285 660 274 632 L 120 680 C 88 690 54 672 45 640 C 36 608 54 575 86 565 L 264 510 C 266 466 275 422 294 382 C 322 324 369 280 424 258 C 392 239 370 205 370 165 C 370 112 412 70 465 70 Z"/></svg>`;

const FALLBACK_BALLET_DANCER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M260 220 C 260 165 305 120 360 120 C 415 120 460 165 460 220 C 460 250 448 277 428 295 C 460 305 490 320 515 345 L 870 110 C 900 90 935 115 925 150 C 918 175 900 195 875 215 L 595 425 C 620 470 635 525 635 585 C 670 580 705 590 735 615 L 970 800 C 1000 825 985 870 945 868 L 540 860 C 510 858 485 838 475 808 C 460 760 440 720 410 685 C 380 760 360 835 350 905 C 345 935 320 950 295 935 C 270 920 260 890 270 860 C 290 780 320 700 360 625 C 330 590 305 545 290 495 C 270 430 270 365 295 305 C 275 287 260 256 260 220 Z"/></svg>`;

const FALLBACK_LEAPING_GIRL_DANCER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M460 200 C 460 145 505 100 560 100 C 615 100 660 145 660 200 C 660 232 645 260 622 278 C 660 285 690 305 712 335 L 940 220 C 970 205 995 235 980 265 C 968 290 945 305 920 318 L 720 420 C 740 470 745 525 735 580 L 970 850 C 990 875 975 905 945 900 L 800 870 C 770 864 745 845 730 818 L 660 690 C 645 700 628 706 610 708 C 700 800 770 880 805 950 C 815 975 795 1000 770 985 C 720 955 660 905 600 845 C 550 795 510 745 480 695 C 460 760 430 825 400 880 L 220 950 C 195 960 175 935 188 912 L 320 690 C 290 660 270 620 260 575 L 60 480 C 35 470 35 435 60 425 L 270 350 C 285 320 308 296 335 280 C 312 262 295 234 295 200 C 295 175 305 152 322 135 C 312 165 318 198 338 220 C 358 240 388 248 415 240 C 412 222 405 207 395 195 C 415 178 437 168 460 165 Z"/></svg>`;

const FALLBACK_FEMALE_GYMNAST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M100 880 C 100 830 140 790 190 790 L 240 790 C 230 720 240 650 275 580 C 200 540 140 470 110 380 C 90 320 130 270 185 295 C 225 312 255 350 275 395 C 305 460 350 510 410 540 C 380 470 380 395 415 325 C 380 305 358 268 358 225 C 358 170 403 125 458 125 C 513 125 558 170 558 225 C 558 268 536 305 501 325 C 540 405 542 495 510 580 C 560 615 600 660 625 715 C 690 690 745 645 780 580 C 810 525 822 460 815 395 C 810 350 850 318 890 340 C 920 357 930 395 920 430 C 895 525 845 605 770 660 C 820 695 855 745 870 800 L 875 790 C 925 790 965 830 965 880 C 965 925 925 960 880 960 C 835 960 800 925 800 880 L 800 870 C 750 858 695 858 645 870 C 590 884 540 905 495 935 C 470 952 438 935 438 905 L 438 880 C 410 880 380 880 350 878 C 320 920 270 950 215 960 C 165 968 120 935 105 890 Z"/></svg>`;

const FALLBACK_GIRL_SINGER_MICROPHONE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M380 130 C 380 80 425 40 480 40 C 535 40 580 80 580 130 C 580 145 577 160 572 173 C 615 180 645 210 660 252 L 730 320 C 740 312 752 308 765 308 L 820 308 L 820 240 C 820 218 838 200 860 200 C 882 200 900 218 900 240 L 900 308 L 955 308 C 980 308 1000 328 1000 353 C 1000 378 980 398 955 398 L 900 398 L 900 460 C 900 482 882 500 860 500 C 838 500 820 482 820 460 L 820 398 L 765 398 C 752 398 740 394 730 386 L 680 340 C 690 380 685 422 660 458 C 695 540 720 625 730 720 C 740 800 730 880 700 940 C 690 960 668 968 650 958 C 632 948 625 925 632 905 C 650 845 655 780 645 715 C 635 645 615 580 590 520 L 590 720 C 590 760 605 800 625 835 L 700 950 C 715 972 700 998 675 995 L 540 980 C 515 977 500 955 510 932 L 540 870 C 510 880 478 882 448 875 L 445 890 C 440 920 415 940 385 935 C 355 930 335 905 340 875 L 360 750 C 370 690 380 630 380 570 L 380 480 C 340 472 305 450 280 418 L 150 480 C 125 492 100 470 110 444 L 175 280 C 188 248 215 225 248 218 L 388 180 C 380 165 380 148 380 130 Z"/></svg>`;

const FALLBACK_BASEBALL_BATTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M340 180 C 340 120 388 72 448 72 C 508 72 556 120 556 180 C 556 195 553 210 548 224 L 620 220 C 605 200 600 175 608 150 C 620 110 660 88 700 100 L 920 165 C 950 174 965 205 955 234 C 945 263 915 278 887 270 L 760 232 L 945 50 C 962 33 990 33 1007 50 C 1024 67 1024 95 1007 112 L 720 400 C 710 410 698 416 685 418 C 720 480 740 550 745 625 C 750 680 745 735 730 788 C 770 805 802 838 815 880 C 825 912 800 945 768 945 L 690 945 L 695 970 C 698 990 682 1000 665 992 L 560 945 L 540 945 C 530 980 498 1002 462 990 C 432 980 415 950 422 920 L 432 870 L 380 870 C 360 870 345 855 345 835 L 345 740 C 320 760 290 770 258 770 C 200 770 155 720 165 662 L 195 480 C 205 420 240 370 290 340 C 270 320 258 290 258 258 C 258 230 268 205 285 185 C 295 220 320 248 350 260 C 348 250 345 235 345 220 Z"/></svg>`;

const FALLBACK_FOOTBALL_QB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M380 60 C 380 30 410 10 440 18 L 600 60 C 630 68 648 95 645 125 L 640 200 C 670 210 695 232 710 262 L 760 358 C 805 320 850 290 905 275 C 935 268 960 295 952 325 C 945 350 925 365 900 372 C 855 384 815 410 785 448 C 825 460 855 488 870 528 L 945 738 C 955 765 935 795 905 795 L 838 795 L 840 825 C 842 850 822 870 798 868 L 700 855 C 685 853 672 845 665 832 L 625 760 C 615 815 615 870 625 925 C 630 955 605 980 575 970 L 488 945 L 470 985 C 460 1005 432 1005 420 985 L 380 920 C 360 935 335 942 310 940 L 200 928 C 168 924 150 895 158 865 L 200 720 C 215 670 250 632 295 615 L 285 540 C 240 525 205 490 188 444 L 140 320 C 130 295 145 268 172 262 L 250 248 C 295 240 340 252 375 280 L 388 295 C 388 265 388 235 392 205 C 365 195 348 168 350 138 C 352 100 380 75 415 75 C 405 70 392 65 380 60 Z"/></svg>`;

const FALLBACK_SOCCER_KICKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M328 145 C 328 90 372 45 428 45 C 484 45 528 90 528 145 C 528 175 515 202 495 220 C 530 235 558 260 575 295 L 640 425 C 720 380 800 340 880 305 C 905 295 932 312 932 340 C 932 365 915 385 892 395 L 700 480 L 855 580 C 880 595 888 628 875 654 L 808 790 C 798 810 775 818 755 808 C 735 798 728 775 738 755 L 790 650 L 615 540 C 600 552 582 558 562 558 L 545 698 C 580 720 608 750 628 785 L 690 895 C 705 920 685 950 658 945 L 540 925 L 520 955 C 510 970 488 970 478 955 L 442 905 L 358 935 C 332 945 305 925 308 898 L 318 800 C 318 760 332 720 358 690 L 305 670 C 268 655 240 625 228 588 L 168 405 C 158 378 175 350 202 345 L 270 332 C 268 305 280 278 305 260 C 280 240 268 215 268 185 C 268 168 272 152 280 138 C 290 175 320 200 358 200 C 348 185 340 168 335 152 Z"/></svg>`;

const FALLBACK_SOCCER_GOALIE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M180 270 C 180 215 225 170 280 170 C 335 170 380 215 380 270 C 380 300 367 327 345 345 C 385 360 418 388 440 425 L 555 615 C 605 595 660 590 715 600 L 845 622 C 855 580 880 545 915 522 L 945 502 C 905 482 882 440 890 395 C 898 350 938 318 985 322 L 985 322 C 980 290 990 258 1015 235 C 1015 235 1010 270 1020 295 L 1050 295 C 1075 295 1085 320 1070 340 L 1015 408 C 1015 445 1000 480 970 502 L 920 540 L 955 565 C 980 582 988 615 975 642 L 920 760 C 910 780 888 788 870 778 L 758 720 C 738 710 728 690 730 670 L 705 665 C 660 658 615 668 580 698 L 480 780 C 460 798 432 795 415 778 L 380 740 L 420 820 C 432 845 412 875 385 870 L 290 855 L 270 882 C 258 898 235 898 225 880 L 175 800 L 105 815 C 78 822 55 798 60 770 L 80 660 C 88 615 115 578 152 555 L 252 495 C 235 478 222 458 215 435 L 160 290 Z"/></svg>`;

const FALLBACK_ICE_HOCKEY_PLAYER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M255 195 C 255 135 305 85 365 85 C 425 85 475 135 475 195 C 475 220 467 243 453 262 L 530 250 C 555 246 580 256 595 277 L 690 410 L 880 200 C 898 180 928 180 945 200 C 962 220 962 250 945 270 L 745 510 L 990 920 C 1005 945 985 975 957 970 L 700 925 C 680 922 663 910 655 892 L 590 760 C 615 850 615 940 595 970 C 585 985 565 988 552 975 L 478 905 L 415 950 C 392 968 358 955 350 928 L 320 820 C 285 850 245 870 200 875 L 60 890 C 30 893 10 865 22 838 L 80 720 C 100 678 140 650 185 645 L 250 638 L 175 415 C 165 388 180 358 208 350 L 280 332 C 268 312 262 288 262 262 C 262 245 265 230 270 215 Z"/></svg>`;

const FALLBACK_BEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M270 160 C 315 145 360 170 380 210 C 420 165 475 140 535 140 C 595 140 650 165 690 210 C 710 170 755 145 800 160 C 855 178 885 240 867 295 C 857 326 834 352 805 366 C 820 402 830 442 832 484 C 900 532 940 612 940 700 C 940 835 830 945 695 945 C 638 945 586 925 545 892 C 518 905 488 912 458 912 C 428 912 398 905 371 892 C 330 925 278 945 221 945 C 86 945 -24 835 -24 700 C -24 612 16 532 84 484 C 86 442 96 402 111 366 C 82 352 59 326 49 295 C 31 240 61 178 116 160 C 161 145 206 158 240 188 C 248 176 258 167 270 160 Z M 255 560 C 183 560 125 618 125 690 C 125 762 183 820 255 820 C 327 820 385 762 385 690 C 385 618 327 560 255 560 Z M 665 560 C 593 560 535 618 535 690 C 535 762 593 820 665 820 C 737 820 795 762 795 690 C 795 618 737 560 665 560 Z"/></svg>`;

const FALLBACK_ANIMAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M780 240 C 810 200 855 190 895 215 C 935 240 950 290 935 335 L 905 425 C 945 480 960 545 945 615 L 920 760 C 915 790 935 815 925 845 L 905 905 C 895 935 858 940 838 915 L 800 870 C 770 875 740 875 710 870 L 700 905 C 690 935 658 945 638 920 L 600 875 C 540 880 480 880 420 875 L 388 920 C 368 945 335 935 325 905 L 312 870 C 282 875 252 870 225 858 L 200 925 C 188 950 152 950 140 925 L 105 855 C 85 845 75 825 78 802 L 95 670 C 65 640 50 600 55 555 L 75 415 C 88 320 162 245 258 230 L 300 224 C 280 200 275 165 290 138 C 312 100 360 88 395 110 L 460 150 C 510 145 560 145 610 152 L 690 168 C 720 175 745 195 760 220 Z"/></svg>`;

const FALLBACK_BIRD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M750 250 C 800 230 850 245 880 285 C 915 330 920 390 895 440 C 945 460 980 505 985 558 C 990 615 955 670 900 685 L 870 690 L 920 760 C 940 785 920 820 890 815 L 720 790 C 690 850 635 890 570 905 L 240 970 C 200 978 165 945 175 905 L 220 720 C 170 705 125 670 95 625 L 30 525 C 10 495 35 458 70 465 L 280 510 C 360 480 450 470 540 480 C 580 442 615 405 645 365 L 700 280 C 712 262 730 252 750 250 Z"/></svg>`;

const FALLBACK_SNAKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M70 850 C 50 780 80 705 145 670 L 380 545 C 430 518 458 465 450 408 L 425 250 C 410 165 470 85 555 75 C 640 65 720 122 735 205 L 760 350 C 810 330 870 348 905 392 C 945 442 945 515 905 565 L 855 625 L 935 600 C 965 590 990 615 980 645 L 950 730 C 935 770 895 795 855 788 L 740 770 C 720 825 670 865 612 870 L 350 895 C 295 900 240 925 200 962 L 150 1010 C 130 1030 95 1015 95 985 L 95 920 C 80 905 70 880 70 850 Z"/></svg>`;

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

const FALLBACK_GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M440 40 L560 40 L580 175 C 615 185 648 200 678 220 L 790 142 L 858 210 L 780 322 C 800 352 815 385 825 420 L 960 440 L 960 560 L 825 580 C 815 615 800 648 780 678 L 858 790 L 790 858 L 678 780 C 648 800 615 815 580 825 L 560 960 L 440 960 L 420 825 C 385 815 352 800 322 780 L 210 858 L 142 790 L 220 678 C 200 648 185 615 175 580 L 40 560 L 40 440 L 175 420 C 185 385 200 352 220 322 L 142 210 L 210 142 L 322 220 C 352 200 385 185 420 175 Z M 500 380 C 434 380 380 434 380 500 C 380 566 434 620 500 620 C 566 620 620 566 620 500 C 620 434 566 380 500 380 Z"/></svg>`;

const FALLBACK_LAPTOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M220 170 C 220 142 242 120 270 120 L 730 120 C 758 120 780 142 780 170 L 780 590 L 900 590 C 925 590 942 615 932 638 L 880 760 C 868 786 842 802 814 802 L 186 802 C 158 802 132 786 120 760 L 68 638 C 58 615 75 590 100 590 L 220 590 Z M 280 180 L 280 580 L 720 580 L 720 180 Z M 420 670 L 580 670 L 600 710 L 400 710 Z"/></svg>`;

const FALLBACK_HELMET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M500 100 C 720 100 900 270 920 490 L 940 690 C 950 760 905 822 838 832 L 720 850 L 720 880 C 720 920 688 952 648 952 L 352 952 C 312 952 280 920 280 880 L 280 850 L 162 832 C 95 822 50 760 60 690 L 80 490 C 100 270 280 100 500 100 Z M 200 580 L 200 660 L 600 660 C 625 660 645 640 645 615 L 645 595 C 645 575 630 560 610 560 L 220 560 C 208 560 200 568 200 580 Z M 700 560 L 700 660 L 800 660 L 800 560 Z"/></svg>`;

const FALLBACK_RIBBON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M500 60 C 660 60 790 190 790 350 C 790 460 730 555 642 605 L 770 920 C 782 950 752 978 723 962 L 580 885 L 525 985 C 513 1005 487 1005 475 985 L 420 885 L 277 962 C 248 978 218 950 230 920 L 358 605 C 270 555 210 460 210 350 C 210 190 340 60 500 60 Z M 500 180 C 406 180 330 256 330 350 C 330 444 406 520 500 520 C 594 520 670 444 670 350 C 670 256 594 180 500 180 Z M 500 250 C 555 250 600 295 600 350 C 600 405 555 450 500 450 C 445 450 400 405 400 350 C 400 295 445 250 500 250 Z"/></svg>`;

const FALLBACK_PIXEL_CHARACTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="M300 80 L700 80 L700 160 L780 160 L780 400 L700 400 L700 480 L820 480 L820 560 L900 560 L900 720 L780 720 L780 640 L700 640 L700 760 L780 760 L780 920 L600 920 L600 760 L400 760 L400 920 L220 920 L220 760 L300 760 L300 640 L220 640 L220 720 L100 720 L100 560 L180 560 L180 480 L300 480 L300 400 L220 400 L220 160 L300 160 Z M 400 240 L 480 240 L 480 320 L 400 320 Z M 520 240 L 600 240 L 600 320 L 520 320 Z"/></svg>`;

const FALLBACK_STAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <path fill="#000" d="M500 80 L610 360 L920 380 L680 560 L760 870 L500 700 L240 870 L320 560 L80 380 L390 360 Z"/>
</svg>`;

const SHAPE_SVG_RULES: Array<{ pattern: RegExp; svg: string; deterministic: boolean }> = [
  { pattern: /(teddy|red panda|bear)/, svg: FALLBACK_BEAR_SVG, deterministic: true },
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
