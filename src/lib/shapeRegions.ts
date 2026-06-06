export type PixelSet = number[];

export interface ShapeRegions {
  head: PixelSet;
  torso: PixelSet;
  leftArm: PixelSet;
  rightArm: PixelSet;
  leftLeg: PixelSet;
  rightLeg: PixelSet;
}

function emptyRegions(): ShapeRegions {
  return {
    head: [],
    torso: [],
    leftArm: [],
    rightArm: [],
    leftLeg: [],
    rightLeg: [],
  };
}

function largestConnectedComponent(
  candidates: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
): PixelSet {
  const visited = new Uint8Array(width * height);
  let best: PixelSet = [];
  const queue = new Int32Array(width * height);

  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] !== 1 || mask[i] !== 1 || visited[i] === 1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    const component: PixelSet = [];

    while (head < tail) {
      const current = queue[head++];
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);

      if (x > 0) {
        const left = current - 1;
        if (candidates[left] === 1 && mask[left] === 1 && visited[left] === 0) {
          visited[left] = 1;
          queue[tail++] = left;
        }
      }
      if (x < width - 1) {
        const right = current + 1;
        if (candidates[right] === 1 && mask[right] === 1 && visited[right] === 0) {
          visited[right] = 1;
          queue[tail++] = right;
        }
      }
      if (y > 0) {
        const up = current - width;
        if (candidates[up] === 1 && mask[up] === 1 && visited[up] === 0) {
          visited[up] = 1;
          queue[tail++] = up;
        }
      }
      if (y < height - 1) {
        const down = current + width;
        if (candidates[down] === 1 && mask[down] === 1 && visited[down] === 0) {
          visited[down] = 1;
          queue[tail++] = down;
        }
      }
    }

    if (component.length > best.length) best = component;
  }

  return best;
}

function makeCandidateMask(
  sourceMask: Uint8Array,
  width: number,
  height: number,
  predicate: (x: number, y: number, i: number) => boolean,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (sourceMask[i] !== 1) continue;
      if (predicate(x, y, i)) out[i] = 1;
    }
  }
  return out;
}

export function segmentRegions(mask: Uint8Array, width: number, height = width): ShapeRegions {
  if (width <= 0 || height <= 0 || mask.length !== width * height) return emptyRegions();

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 1) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return emptyRegions();

  const bboxHeight = Math.max(1, maxY - minY + 1);
  const headCut = minY + Math.floor(bboxHeight * 0.2);
  const torsoEnd = minY + Math.floor(bboxHeight * 0.6);
  const armTop = minY + Math.floor(bboxHeight * 0.18);
  const armBottom = minY + Math.floor(bboxHeight * 0.68);
  const legTop = minY + Math.floor(bboxHeight * 0.6);

  let torsoCenterSum = 0;
  let torsoHalfWidthSum = 0;
  let torsoRows = 0;
  const torsoBandStart = minY + Math.floor(bboxHeight * 0.2);
  const torsoBandEnd = minY + Math.floor(bboxHeight * 0.6);
  for (let y = torsoBandStart; y <= torsoBandEnd; y++) {
    if (y < 0 || y >= height) continue;
    const row = y * width;
    let rowMin = width;
    let rowMax = -1;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 1) continue;
      if (x < rowMin) rowMin = x;
      if (x > rowMax) rowMax = x;
    }
    if (rowMax < rowMin) continue;
    torsoCenterSum += (rowMin + rowMax) * 0.5;
    torsoHalfWidthSum += Math.max(1, (rowMax - rowMin + 1) * 0.5);
    torsoRows++;
  }
  const fallbackCenter = (minX + maxX) * 0.5;
  const fallbackHalfWidth = Math.max(2, (maxX - minX + 1) * 0.25);
  const torsoCenterX = torsoRows > 0 ? torsoCenterSum / torsoRows : fallbackCenter;
  const torsoHalfWidth = torsoRows > 0 ? Math.max(2, (torsoHalfWidthSum / torsoRows) * 0.75) : fallbackHalfWidth;

  const headCandidates = makeCandidateMask(mask, width, height, (_, y) => y <= headCut);
  const torsoCandidates = makeCandidateMask(mask, width, height, (x, y) => {
    if (y <= headCut || y > torsoEnd) return false;
    return Math.abs(x - torsoCenterX) <= torsoHalfWidth * 1.2;
  });
  const leftArmCandidates = makeCandidateMask(mask, width, height, (x, y) => {
    if (y < armTop || y > armBottom) return false;
    return x < torsoCenterX - torsoHalfWidth * 0.85;
  });
  const rightArmCandidates = makeCandidateMask(mask, width, height, (x, y) => {
    if (y < armTop || y > armBottom) return false;
    return x > torsoCenterX + torsoHalfWidth * 0.85;
  });
  const leftLegCandidates = makeCandidateMask(mask, width, height, (x, y) => y >= legTop && x <= torsoCenterX);
  const rightLegCandidates = makeCandidateMask(mask, width, height, (x, y) => y >= legTop && x > torsoCenterX);

  const head = largestConnectedComponent(headCandidates, mask, width, height);
  const torso = largestConnectedComponent(torsoCandidates, mask, width, height);
  const leftArm = largestConnectedComponent(leftArmCandidates, mask, width, height);
  const rightArm = largestConnectedComponent(rightArmCandidates, mask, width, height);
  const leftLeg = largestConnectedComponent(leftLegCandidates, mask, width, height);
  const rightLeg = largestConnectedComponent(rightLegCandidates, mask, width, height);

  return { head, torso, leftArm, rightArm, leftLeg, rightLeg };
}
