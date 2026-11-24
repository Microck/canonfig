/** Dither geometry shared by the GUI and the static website. All units are cells. */

export interface ThresholdMap {
  /** Width and height in cells. The map tiles in both directions. */
  readonly size: number;
  /** Row-major thresholds in (0, 1). */
  readonly thresholds: Float32Array;
  /** Row-major ranks, 0 to `size * size - 1` (0 to 255 for blue noise). */
  readonly ranks: Uint8Array;
  /** Distinct thresholds, so `levels` tones fill it from paper to ink. */
  readonly steps: number;
}

export const fromRanks = (size: number, ranks: Uint8Array, steps: number) => ({
  ranks,
  size,
  steps,
  thresholds: Float32Array.from(ranks, (rank) => (rank + 0.5) / steps),
});

// Bayer ranks: interleave the bits of (x xor y) and y, least significant
// first, so each 2x2 block of the previous size splits into four.
export const bayerRanks = (size: number): Uint8Array => {
  const ranks = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rank = 0;
      for (let bit = 1; bit < size; bit *= 2) {
        const xBit = Math.floor(x / bit) % 2;
        const yBit = Math.floor(y / bit) % 2;
        rank = rank * 4 + 2 * ((xBit + yBit) % 2) + yBit;
      }
      ranks[y * size + x] = rank;
    }
  }
  return ranks;
};

export const BAYER_4: ThresholdMap = fromRanks(4, bayerRanks(4), 16);
export const BAYER_8: ThresholdMap = fromRanks(8, bayerRanks(8), 64);

/** The side of a shape where a gradient fill is densest. */
export type FillEdge = "top" | "bottom" | "left" | "right";

/** Write one SVG path covering the inked cells of a grid, in cell units. */
const cellsPath = (
  width: number,
  height: number,
  inked: (x: number, y: number) => boolean
) => {
  let path = "";
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const on = x < width && inked(x, y);
      if (on && start === -1) {
        start = x;
      } else if (!on && start !== -1) {
        path += `M${start} ${y}h${x - start}v1h${start - x}z`;
        start = -1;
      }
    }
  }
  return path;
};

/** One tile of a texture: its side in cells and the inked cells as a path. */
export interface FillTile {
  size: number;
  path: string;
}

// Dots on a staggered lattice: every other cell, rows offset by one.
const DOTTED: FillTile = {
  path: cellsPath(4, 4, (x, y) => y % 2 === 0 && (x + y / 2) % 2 === 0),
  size: 4,
};

// Rising diagonals, one cell wide, four cells apart.
const HATCHED: FillTile = {
  path: cellsPath(4, 4, (x, y) => (x + y) % 4 === 3),
  size: 4,
};

/** The repeating tile of a textured variant. */
export const fillTile = (variant: "dotted" | "hatched"): FillTile =>
  variant === "dotted" ? DOTTED : HATCHED;

export interface RampTile {
  /** Tile width in cells. */
  width: number;
  /** Tile height in cells. */
  height: number;
  path: string;
}

export interface RampGeometryOptions {
  /** Side where the ramp is densest. */
  edge: FillEdge;
  /** Length of the fade in cells. */
  length: number;
  /** Total length of the tile in cells, at least `length`. Past the fade it holds `to`. */
  extent?: number;
  /** Coverage at the edge, 0 to 1. */
  from: number;
  /** Coverage at the far end of the fade, 0 to 1. */
  to: number;
}

export function rampTile(
  { edge, length, extent = length, from, to }: RampGeometryOptions,
  matrix: ThresholdMap = BAYER_4,
): RampTile {
  const { size, thresholds } = matrix;
  const fade = Math.max(1, Math.round(length));
  const along = Math.ceil(Math.max(fade, extent) / size) * size;
  const vertical = edge === "top" || edge === "bottom";
  const width = vertical ? size : along;
  const height = vertical ? along : size;
  const levelAt = (index: number) => {
    const step = edge === "top" || edge === "left" ? index : along - 1 - index;
    return step >= fade ? to : from + (to - from) * ((step + 0.5) / fade);
  };
  return {
    height,
    path: cellsPath(
      width,
      height,
      (x, y) =>
        levelAt(vertical ? y : x) >
        (thresholds[(y % size) * size + (x % size)] ?? 1)
    ),
    width,
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Quantize a continuous [0, 1] field onto a square Bayer grid into `stops` SVG paths. */
function fieldStopPaths(
  cells: number,
  fieldAt: (u: number, v: number) => number,
  stops: number,
  matrix: ThresholdMap = BAYER_4,
): string[] {
  const layers = Array.from({ length: stops }, () => "");
  const { size, thresholds } = matrix;
  for (let row = 0; row < cells; row += 1) {
    const v = 1 - (row + 0.5) / cells;
    const my = (cells - 1 - row) % size;
    let activeStop = 0;
    let runStart = 0;
    const flush = (end: number) => {
      if (activeStop > 0 && end > runStart) {
        layers[activeStop - 1] += `M${runStart} ${row}h${end - runStart}v1h${runStart - end}z`;
      }
    };
    for (let col = 0; col <= cells; col += 1) {
      let stop = 0;
      if (col < cells) {
        const tone = clamp01(fieldAt((col + 0.5) / cells, v));
        const th = thresholds[my * size + (col % size)] ?? 1;
        const scaled = tone * stops;
        let idx = Math.floor(scaled);
        if (scaled - idx >= th && idx < stops) idx += 1;
        stop = idx;
      }
      if (stop !== activeStop) {
        flush(col);
        activeStop = stop;
        runStart = col;
      }
    }
  }
  return layers;
}

/**
 * Three-stop Bayer 4x4 diagonal corner wash for machine icon tiles (`dim`, `mid`, `bright`).
 * Carves a dark center pocket behind the glyph so icons keep contrast on any accent;
 * `source` adds a top-right corner emitter glint.
 */
export function cornerWashPaths(cells: number, source: boolean): readonly [string, string, string] {
  const [dim = "", mid = "", bright = ""] = fieldStopPaths(
    cells,
    (u, v) => {
      const r = Math.hypot(u - 0.5, v - 0.5);
      const halo = smoothstep(0.23, 0.43, r);
      const diag = clamp01((u * 0.88 + (1 - v) * 0.96 - 0.56) / 1.12);
      let tone = diag * (source ? 0.88 : 0.7) * (0.1 + 0.9 * halo);
      if (source) {
        const dTopRight = Math.hypot(u - 0.94, v - 0.94);
        tone = Math.max(tone, Math.exp(-dTopRight * 7.2) * 0.98);
      }
      return tone;
    },
    3,
  );
  return [dim, mid, bright];
}

/** Single-stop carved diagonal sheen layered over an active syncing machine icon tile. */
export function syncSheenPath(cells: number): string {
  return (
    fieldStopPaths(
      cells,
      (u, v) => {
        const r = Math.hypot(u - 0.5, v - 0.5);
        const halo = smoothstep(0.23, 0.43, r);
        const diagCoord = (u + (1 - v)) * 0.5;
        return Math.exp(-Math.abs(diagCoord - 0.58) * 11) * 0.58 * (0.18 + 0.82 * halo);
      },
      1,
    )[0] ?? ""
  );
}
