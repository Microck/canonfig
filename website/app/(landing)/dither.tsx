/**
 * Ordered dithering, the GUI's only texture (ui/docs/design/dither.md), in
 * the two forms this page uses:
 *
 * - `FillPattern`: an SVG `<pattern>` for picture tiles and matrix cells, the
 *   GUI's `solid`, `dotted`, `hatched` and edge-ramp fills
 *   (ui/src/lib/dither/style.ts, fill.tsx).
 * - `horizonLevel`: the still frame of the GUI's `StateBand` field in its calm
 *   `ok` state (ui/src/shared/shared.tsx HORIZON_FIELD at stillTime 4), drawn
 *   once by `DitherBand`.
 *
 * Ported rather than imported, because the website and ui/ are separate
 * builds. Keep them in step when the GUI's texture changes.
 */

const SIZE = 4;
const SIZE_8 = 8;

// Bayer ranks: interleave the bits of (x xor y) and y, least significant
// first, so each 2x2 block of the previous size splits into four.
function bayerThresholds(size: number) {
  return Array.from({ length: size * size }, (_, index) => {
    const x = index % size;
    const y = Math.floor(index / size);
    let rank = 0;
    for (let bit = 1; bit < size; bit *= 2) {
      const xBit = Math.floor(x / bit) % 2;
      const yBit = Math.floor(y / bit) % 2;
      rank = rank * 4 + 2 * ((xBit + yBit) % 2) + yBit;
    }
    return (rank + 0.5) / (size * size);
  });
}

const THRESHOLDS = bayerThresholds(SIZE);
const THRESHOLDS_8 = bayerThresholds(SIZE_8);

/** The Bayer 4x4 threshold in (0, 1) at cell (x, y); coordinates wrap. */
export const thresholdAt = (x: number, y: number) => THRESHOLDS[(y % SIZE) * SIZE + (x % SIZE)] ?? 1;

/** The Bayer 8x8 threshold in (0, 1) at cell (x, y); coordinates wrap. */
export const thresholdAt8 = (x: number, y: number) => THRESHOLDS_8[(y % SIZE_8) * SIZE_8 + (x % SIZE_8)] ?? 1;

/** One SVG path covering the inked cells of a grid, in cell units. */
function cellsPath(width: number, height: number, inked: (x: number, y: number) => boolean) {
  let path = '';
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const on = x < width && inked(x, y);
      if (on && start === -1) start = x;
      else if (!on && start !== -1) {
        path += `M${start} ${y}h${x - start}v1h${start - x}z`;
        start = -1;
      }
    }
  }
  return path;
}

// Dots on a staggered lattice and rising diagonals, as in the GUI.
const DOTTED = cellsPath(4, 4, (x, y) => y % 2 === 0 && (x + y / 2) % 2 === 0);
const HATCHED = cellsPath(4, 4, (x, y) => (x + y) % 4 === 3);

export type Fill = 'solid' | 'dotted' | 'hatched' | 'ramp' | 'ramp-x';

/**
 * An SVG pattern for one fill. `ramp` is the GUI's gradient fill: dense at
 * the bottom edge of a box of `height` user units starting at `y`, thinning
 * to `to` over that height (the machine map's icon tiles use 0.5 to 0).
 * `ramp-x` is the same along a box of `width` units from `x`, dense at its
 * right edge: the GUI's DitherProgress fill, densest at the leading edge.
 */
export function FillPattern({
  id,
  fill,
  color,
  cell = 1.5,
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  from = 0.5,
  to = 0,
}: {
  id: string;
  fill: Fill;
  color: string;
  cell?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  from?: number;
  to?: number;
}) {
  if (fill === 'solid') {
    return (
      <pattern id={id} width={cell} height={cell} patternUnits="userSpaceOnUse">
        <rect width={cell} height={cell} fill={color} />
      </pattern>
    );
  }
  if (fill === 'ramp') {
    // One matrix wide, `rows` tall, so it lines up with the box it fills.
    const rows = Math.max(SIZE, Math.ceil(height / cell / SIZE) * SIZE);
    const path = cellsPath(SIZE, rows, (column, row) => {
      const fromBottom = (rows - 1 - row + 0.5) / rows;
      return from + (to - from) * fromBottom > thresholdAt(column, row);
    });
    return (
      <pattern className="dither-cells" id={id} y={y + height - rows * cell} width={SIZE * cell} height={rows * cell} patternUnits="userSpaceOnUse">
        <path d={path} transform={`scale(${cell})`} fill={color} />
      </pattern>
    );
  }
  if (fill === 'ramp-x') {
    // One matrix tall, `columns` wide, ending at the box's right edge.
    const columns = Math.max(SIZE, Math.ceil(width / cell / SIZE) * SIZE);
    const path = cellsPath(columns, SIZE, (column, row) => {
      const fromRight = (columns - 1 - column + 0.5) / columns;
      return from + (to - from) * fromRight > thresholdAt(column, row);
    });
    return (
      <pattern className="dither-cells" id={id} x={x + width - columns * cell} width={columns * cell} height={SIZE * cell} patternUnits="userSpaceOnUse">
        <path d={path} transform={`scale(${cell})`} fill={color} />
      </pattern>
    );
  }
  return (
    <pattern className="dither-cells" id={id} width={SIZE * cell} height={SIZE * cell} patternUnits="userSpaceOnUse">
      <path d={fill === 'dotted' ? DOTTED : HATCHED} transform={`scale(${cell})`} fill={color} />
    </pattern>
  );
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const fract = (x: number) => x - Math.floor(x);

/**
 * The GUI `StateBand` still frame for `ok` (orbital iso-contours at t=4) and
 * `warn` (moire fault seam at t=0.63). `u` runs 0 to 1 left to right, `v` 0 to 1
 * bottom to top; `aspect` is the band's width over its height.
 */
export function horizonLevel(u: number, v: number, aspect: number, tone: 'ok' | 'warn' = 'ok') {
  const px = u * aspect;
  if (tone === 'warn') {
    const t = 0.63;
    const seam = (u - 0.68) * 1.4 + (v - 0.5) * 0.55 + 0.08 * Math.sin(v * 5 + t * 0.8);
    const wA = 0.5 + 0.5 * Math.sin(px * 9.5 + v * 4 + t * 0.7);
    const wB = 0.5 + 0.5 * Math.sin(px * 9.5 - v * 6.5 - t * 0.55 + 1.4);
    const interference = seam > 0 ? wA * 0.65 + wB * 0.35 : wB * 0.75;
    const faultGlow = Math.exp(-Math.abs(seam) * 5.2) * (0.65 + 0.35 * Math.sin(t * 2.4));
    const base = smoothstep(0.28, 0.82, u) * (0.35 + 0.45 * interference);
    return Math.min(1, Math.max(0, base * 0.72 + faultGlow * 0.88 * smoothstep(0.2, 0.55, u)));
  }
  const t = 4;
  const dx = px - 0.86 * aspect;
  const dy = v - 0.22;
  const r = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const warp = 0.08 * Math.sin(ang * 3 + t * 0.35) + 0.04 * Math.cos(r * 5 - t * 0.25);
  const rings = Math.abs(fract((r + warp) * 3.1 - t * 0.08) - 0.5) * 2;
  const ridge = smoothstep(0.55, 0.98, rings);
  const core = Math.exp(-r * 1.15);
  const strata = 0.32 * smoothstep(0.95, 0.05, v + 0.12 * Math.sin(px * 2.2 + t * 0.2));
  const crest = Math.pow(Math.max(ridge, 0), 3) * smoothstep(1.9, 0.15, r) * 0.72;
  const rightWeight = smoothstep(0.18, 0.78, u);
  return Math.min(1, Math.max(0, (core * 0.65 + strata * 0.55 + crest) * (0.25 + 0.85 * rightWeight)));
}
