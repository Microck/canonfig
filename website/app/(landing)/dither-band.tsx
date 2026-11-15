'use client';

import { useEffect, useRef } from 'react';
import { horizonLevel, thresholdAt } from './dither';

// The GUI band's cell, in CSS pixels.
const CELL = 2;

/**
 * The GUI's `StateBand` field as a still: the dithered horizon, faded out on
 * every side by the mask on `.dither-band` (page.css). Drawn once per size on
 * a canvas of one pixel per cell, scaled up without smoothing; it never
 * animates. Place it as the first child of a `position: relative; isolation:
 * isolate` box.
 */
export function DitherBand({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Redraw only when the box changes size: the band is a function of its
  // width and height in cells.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let drawnCols = 0;
    let drawnRows = 0;
    const draw = () => {
      const cols = Math.ceil(canvas.clientWidth / CELL);
      const rows = Math.ceil(canvas.clientHeight / CELL);
      if (cols === 0 || rows === 0) return;
      if (cols === drawnCols && rows === drawnRows) return;
      drawnCols = cols;
      drawnRows = rows;
      canvas.width = cols;
      canvas.height = rows;
      context.fillStyle = getComputedStyle(canvas).color;
      for (let row = 0; row < rows; row += 1) {
        const v = 1 - (row + 0.5) / rows;
        for (let col = 0; col < cols; col += 1) {
          if (horizonLevel((col + 0.5) / cols, v, cols / rows) > thresholdAt(col, row)) context.fillRect(col, row, 1, 1);
        }
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return (
    <span className={`dither-band${className ? ` ${className}` : ''}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </span>
  );
}
