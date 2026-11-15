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

// Bayer 4x4 ranks: interleave the bits of (x xor y) and y, least significant
// first, so each 2x2 block of the previous size splits into four.
const THRESHOLDS = Array.from({ length: SIZE * SIZE }, (_, index) => {
  const x = index % SIZE;
  const y = Math.floor(index / SIZE);
  let rank = 0;
  for (let bit = 1; bit < SIZE; bit *= 2) {
    const xBit = Math.floor(x / bit) % 2;
    const yBit = Math.floor(y / bit) % 2;
    rank = rank * 4 + 2 * ((xBit + yBit) % 2) + yBit;
  }
  return (rank + 0.5) / (SIZE * SIZE);
});

/** The Bayer threshold in (0, 1) at cell (x, y); coordinates wrap. */
export const thresholdAt = (x: number, y: number) => THRESHOLDS[(y % SIZE) * SIZE + (x % SIZE)] ?? 1;

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

/**
 * The GUI band's calm horizon at its still frame: two waves along the top of
 * a body that is densest at the bottom, shaded by a fine diagonal grain.
 * `u` runs 0 to 1 left to right, `v` 0 to 1 bottom to top; `aspect` is the
 * band's width over its height.
 */
export function horizonLevel(u: number, v: number, aspect: number) {
  const t = 4;
  const px = u * aspect;
  const wave = 0.06 * Math.sin(px * 3 + t * 0.35) + 0.04 * Math.sin(px * 7 - t * 0.2);
  const body = smoothstep(0.85, 0, v + wave);
  const grain = 0.5 + 0.5 * Math.sin(px * 18 + v * 9 + t * 0.15);
  return body * (0.75 + 0.25 * grain) * 0.9;
}
