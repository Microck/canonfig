import { BAYER_4 } from "./geometry";

export const HORIZON_CELL = 2;
export const HORIZON_STILL_TIME = 4;
export const HORIZON_HEIGHT = 0.85;
export const HORIZON_LEVEL = 0.9;
export const HORIZON_GRAIN_DEPTH = 0.25;

// Each term is a sine wave weighted by amplitude. The same coefficients drive
// the animated GUI field and the CPU still frame used in the static website.
type Harmonic = readonly [amplitude: number, x: number, y: number, time: number];
const WAVES = [
  [0.06, 3, 0, 0.35],
  [0.04, 7, 0, -0.2],
] as const satisfies readonly [Harmonic, Harmonic];
const GRAIN_BIAS = 0.5;
const GRAIN = [0.5, 18, 9, 0.15] as const satisfies Harmonic;

const sineAt = ([amplitude, x, y, time]: Harmonic, px: number, py: number, t: number) =>
  amplitude * Math.sin(x * px + y * py + time * t);

export const glslFloat = (number: number): string => Number.isInteger(number) ? `${number}.0` : String(number);

const sineGlsl = ([amplitude, x, y, time]: Harmonic) =>
  `${glslFloat(amplitude)} * sin(p.x * ${glslFloat(x)} + p.y * ${glslFloat(y)} + t * ${glslFloat(time)})`;

export const HORIZON_WAVES_GLSL = WAVES.map(sineGlsl).join(" + ");
export const HORIZON_GRAIN_GLSL = `${glslFloat(GRAIN_BIAS)} + ${sineGlsl(GRAIN)}`;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const horizonLevel = (px: number, v: number) => {
  const t = HORIZON_STILL_TIME;
  const wave = sineAt(WAVES[0], px, v, t) + sineAt(WAVES[1], px, v, t);
  const body = 1 - smoothstep(0, HORIZON_HEIGHT, v + wave);
  const grain = GRAIN_BIAS + sineAt(GRAIN, px, v, t);
  return body * (1 - HORIZON_GRAIN_DEPTH + HORIZON_GRAIN_DEPTH * grain) * HORIZON_LEVEL;
};

/** Visit the calm horizon's ink cells, row-major from the top for canvas. */
export function forEachHorizonInkCell(columns: number, rows: number, ink: (column: number, row: number) => void) {
  const { size, thresholds } = BAYER_4;
  for (let row = 0; row < rows; row += 1) {
    // WebGL measures both coordinates and threshold rows from the bottom.
    const bottomRow = rows - 1 - row;
    const v = (bottomRow + 0.5) / rows;
    for (let column = 0; column < columns; column += 1) {
      const px = (column + 0.5) / rows;
      const cutoff = thresholds[(bottomRow % size) * size + (column % size)] ?? 1;
      // The Bayer thresholds are the midpoints of the GUI shader's tone levels.
      if (horizonLevel(px, v) >= cutoff) ink(column, row);
    }
  }
}
