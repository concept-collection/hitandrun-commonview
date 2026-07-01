import { useEffect, useRef, type CSSProperties } from "react";
import type { Points } from "../types";

export type { Points };

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Pt {
  x: number;
  y: number;
}

interface RegionViewProps {
  /** Convex region boundary, in counterclockwise world coordinates. */
  region: Points;
  /** Sample points to scatter inside the region. */
  samples: Points;
  /** Animation overlay: the in-region segments the current step samples along
   *  (one for a convex region; possibly several for a non-convex one). */
  segments?: Segment[] | null;
  /** Animation overlay: the current point the step starts from (ringed). */
  from?: Pt | null;
  /** Animation overlay: the freshly sampled point (highlighted). */
  newPoint?: Pt | null;
}

const FILL = "rgba(37, 99, 235, 0.08)";
const STROKE = "#2563eb";
const DOT = "rgba(15, 23, 42, 0.55)";
const DOT_RADIUS = 1.6;
const MARGIN = 28;

const CHORD = "#f59e0b"; // amber: the candidate segment + its boundary hits
const PREV = "#d97706"; // deeper amber dot: the sample the chord starts from
const NEW = "#0f172a"; // near-black: the freshly sampled point (circled)

/** Renders the region outline and the samples on a 2D canvas, fitting the
 *  region to the available space (aspect-ratio preserved, y pointing up). The
 *  optional `chord` / `from` / `newPoint` overlay drives the sampling movie.
 *  The canvas is redrawn on data change and on resize, and is devicePixelRatio
 *  aware so dots and edges stay crisp. */
export function RegionView({
  region,
  samples,
  segments,
  from,
  newPoint,
}: RegionViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const cssW = container.clientWidth;
      const cssH = container.clientHeight;
      if (cssW === 0 || cssH === 0) return;

      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      if (region.x.length < 3) return;

      // World bounds from the region (samples lie inside it).
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < region.x.length; i++) {
        minX = Math.min(minX, region.x[i]);
        maxX = Math.max(maxX, region.x[i]);
        minY = Math.min(minY, region.y[i]);
        maxY = Math.max(maxY, region.y[i]);
      }
      const worldW = maxX - minX || 1;
      const worldH = maxY - minY || 1;

      // Fit preserving aspect ratio; center within the margins.
      const scale = Math.min(
        (cssW - 2 * MARGIN) / worldW,
        (cssH - 2 * MARGIN) / worldH
      );
      const offX = (cssW - worldW * scale) / 2;
      const offY = (cssH - worldH * scale) / 2;
      // World (x right, y up) → pixel (x right, y down).
      const toPx = (x: number) => offX + (x - minX) * scale;
      const toPy = (y: number) => cssH - (offY + (y - minY) * scale);

      // Region: translucent fill + crisp outline.
      ctx.beginPath();
      ctx.moveTo(toPx(region.x[0]), toPy(region.y[0]));
      for (let i = 1; i < region.x.length; i++) {
        ctx.lineTo(toPx(region.x[i]), toPy(region.y[i]));
      }
      ctx.closePath();
      ctx.fillStyle = FILL;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = STROKE;
      ctx.stroke();

      // Samples: small filled dots.
      ctx.fillStyle = DOT;
      const n = Math.min(samples.x.length, samples.y.length);
      for (let i = 0; i < n; i++) {
        const cx = toPx(samples.x[i]);
        const cy = toPy(samples.y[i]);
        ctx.beginPath();
        ctx.arc(cx, cy, DOT_RADIUS, 0, 2 * Math.PI);
        ctx.fill();
      }

      // Animation overlay (movie mode): the in-region segment(s) of the line.
      if (segments) {
        for (const seg of segments) {
          const x0 = toPx(seg.x0);
          const y0 = toPy(seg.y0);
          const x1 = toPx(seg.x1);
          const y1 = toPy(seg.y1);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.strokeStyle = CHORD;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          // Open circles where the line crosses the region boundary.
          ctx.lineWidth = 1.25;
          for (const [ex, ey] of [
            [x0, y0],
            [x1, y1],
          ]) {
            ctx.beginPath();
            ctx.arc(ex, ey, 3, 0, 2 * Math.PI);
            ctx.stroke();
          }
        }
      }
      // Previous sample: the point the chord starts from — a filled amber dot.
      if (from) {
        ctx.beginPath();
        ctx.arc(toPx(from.x), toPy(from.y), 4, 0, 2 * Math.PI);
        ctx.fillStyle = PREV;
        ctx.fill();
      }
      // New sample: a circled black point.
      if (newPoint) {
        const cx = toPx(newPoint.x);
        const cy = toPy(newPoint.y);
        ctx.beginPath();
        ctx.arc(cx, cy, 6.5, 0, 2 * Math.PI);
        ctx.strokeStyle = NEW;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 3.2, 0, 2 * Math.PI);
        ctx.fillStyle = NEW;
        ctx.fill();
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [region, samples, segments, from, newPoint]);

  return (
    <div ref={containerRef} style={containerStyle}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}

const containerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
};
