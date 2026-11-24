'use client';

import { useEffect, useRef } from 'react';
import { horizonLevel, thresholdAt, thresholdAt8 } from './dither';

// The GUI band's cell, in CSS pixels.
const CELL = 2;

/**
 * The GUI's `StateBand` field as a still: orbital iso-contours (`ok`, Bayer 8x8)
 * or the diagonal moire fault seam (`warn`, Bayer 4x4) in a 3-stop Ender ramp,
 * faded out by the mask on `.dither-band` (page.css) or `.pub-band` (publish.css).
 * Drawn once per size on a canvas of one pixel per cell, scaled up without
 * smoothing; it never animates. Place it as the first child of a
 * `position: relative; isolation: isolate` box.
 */
export function DitherBand({ className, tone = 'ok' }: { className?: string; tone?: 'ok' | 'warn' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Redraw only when the box changes size or tone changes: the band is a function
  // of its width and height in cells.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let drawnCols = 0;
    let drawnRows = 0;
    const threshold = tone === 'warn' ? thresholdAt : thresholdAt8;
    const draw = () => {
      const cols = Math.ceil(canvas.clientWidth / CELL);
      const rows = Math.ceil(canvas.clientHeight / CELL);
      if (cols === 0 || rows === 0) return;
      if (cols === drawnCols && rows === drawnRows) return;
      drawnCols = cols;
      drawnRows = rows;
      canvas.width = cols;
      canvas.height = rows;
      const styles = getComputedStyle(canvas);
      const mid = styles.color;
      const dim = styles.getPropertyValue('--band-dim').trim() || mid;
      const bright = styles.getPropertyValue('--band-bright').trim() || mid;
      const stops = [null, dim, mid, bright] as const;
      const last = stops.length - 1;
      for (let row = 0; row < rows; row += 1) {
        const v = 1 - (row + 0.5) / rows;
        for (let col = 0; col < cols; col += 1) {
          const level = horizonLevel((col + 0.5) / cols, v, cols / rows, tone);
          const scaled = level * last;
          let index = Math.floor(scaled);
          if (scaled - index >= threshold(col, row) && index < last) index += 1;
          const color = stops[index];
          if (color) {
            context.fillStyle = color;
            context.fillRect(col, row, 1, 1);
          }
        }
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [tone]);

  return (
    <span className={`dither-band${className ? ` ${className}` : ''}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </span>
  );
}
