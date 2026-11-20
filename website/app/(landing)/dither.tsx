import { BAYER_4, fillTile, rampTile } from '../../../ui/src/lib/dither/geometry';

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
