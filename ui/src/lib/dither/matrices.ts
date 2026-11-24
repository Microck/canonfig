import { BAYER_4, BAYER_8, bayerRanks, fromRanks, type ThresholdMap } from "./geometry";
import { BLUE_NOISE_64_BASE64 } from "@/lib/dither/blue-noise";

/**
 * Threshold maps for ordered dithering. A cell is inked when the tone at
 * that cell is above its threshold, so a tone of 0.25 inks a quarter of the
 * cells. Thresholds sit halfway between steps, `(rank + 0.5) / cells`, so no
 * tone ever lands exactly on one.
 */

export type DitherMatrix = "bayer2" | "bayer4" | "bayer8" | "blue-noise";

export const DITHER_MATRICES = [
  "bayer2",
  "bayer4",
  "bayer8",
  "blue-noise",
] as const satisfies readonly DitherMatrix[];

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
};

export const BAYER_2: ThresholdMap = fromRanks(2, bayerRanks(2), 4);
export { BAYER_4, BAYER_8 };
export type { ThresholdMap };

/** 64x64 void-and-cluster blue noise, 256 levels of 16 cells each. */
export const BLUE_NOISE_64: ThresholdMap = fromRanks(
  64,
  decodeBase64(BLUE_NOISE_64_BASE64),
  256
);

export const getThresholdMap = (matrix: DitherMatrix): ThresholdMap => {
  switch (matrix) {
    case "bayer2": {
      return BAYER_2;
    }
    case "bayer4": {
      return BAYER_4;
    }
    case "bayer8": {
      return BAYER_8;
    }
    case "blue-noise": {
      return BLUE_NOISE_64;
    }
    default: {
      const exhaustive: never = matrix;
      return exhaustive;
    }
  }
};

const wrap = (value: number, size: number) =>
  ((Math.floor(value) % size) + size) % size;

/** The threshold in (0, 1) at cell (x, y). Coordinates wrap. */
export const thresholdAt = (matrix: DitherMatrix, x: number, y: number) => {
  const map = getThresholdMap(matrix);
  return map.thresholds[wrap(y, map.size) * map.size + wrap(x, map.size)] ?? 0;
};

/** Whether a cell is inked for a tone in [0, 1]. */
export const isInked = (
  matrix: DitherMatrix,
  x: number,
  y: number,
  tone: number
) => tone > thresholdAt(matrix, x, y);
