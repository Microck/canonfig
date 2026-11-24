import { BAYER_4, BAYER_8, fillTile, rampTile } from '../../../ui/src/lib/dither/geometry';

/** The Bayer 4x4 threshold in (0, 1) at cell (x, y); coordinates wrap. */
export const thresholdAt = (x: number, y: number) =>
  BAYER_4.thresholds[(y % BAYER_4.size) * BAYER_4.size + (x % BAYER_4.size)] ?? 1;

/** The Bayer 8x8 threshold in (0, 1) at cell (x, y); coordinates wrap. */
export const thresholdAt8 = (x: number, y: number) =>
  BAYER_8.thresholds[(y % BAYER_8.size) * BAYER_8.size + (x % BAYER_8.size)] ?? 1;

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
  if (fill === 'ramp' || fill === 'ramp-x') {
    const vertical = fill === 'ramp';
    const { size } = BAYER_4;
    // On the landing page the fade fills the whole box, aligned at its dense edge.
    const length = Math.max(size, Math.ceil((vertical ? height : width) / cell / size) * size);
    const tile = rampTile({ edge: vertical ? 'bottom' : 'right', length, from, to });
    const tileWidth = tile.width * cell;
    const tileHeight = tile.height * cell;
    return (
      <pattern
        className="dither-cells"
        id={id}
        x={vertical ? undefined : x + width - tileWidth}
        y={vertical ? y + height - tileHeight : undefined}
        width={tileWidth}
        height={tileHeight}
        patternUnits="userSpaceOnUse"
      >
        <path d={tile.path} transform={`scale(${cell})`} fill={color} />
      </pattern>
    );
  }
  const tile = fillTile(fill);
  return (
    <pattern className="dither-cells" id={id} width={tile.size * cell} height={tile.size * cell} patternUnits="userSpaceOnUse">
      <path d={tile.path} transform={`scale(${cell})`} fill={color} />
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
