// Ring layout geometry. PURE — no DOM. The view consumes these coordinates.

export interface RingPoint {
  x: number;
  y: number;
  /** radians, measured from the +x axis (standard SVG) */
  angle: number;
}

/**
 * Evenly place `count` nodes on a circle of `radius` about (cx, cy).
 * First node sits at 12 o'clock (-PI/2) and they proceed clockwise, so the
 * rarity-ranked first contact reads as "due north".
 */
export function placeRing(
  count: number,
  radius: number,
  cx: number,
  cy: number,
  startAngle: number = -Math.PI / 2
): RingPoint[] {
  if (count <= 0) return [];
  const step = (2 * Math.PI) / count;
  const pts: RingPoint[] = [];
  for (let i = 0; i < count; i++) {
    const angle = startAngle + i * step; // clockwise in SVG's y-down space
    pts.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), angle });
  }
  return pts;
}

/** Radii for the two graticule range-rings given the square viewport size.
 * Pulled in from the edge to leave horizontal room for contact labels. */
export function ringRadii(viewSize: number): { inner: number; outer: number } {
  const half = viewSize / 2;
  return { inner: half * 0.32, outer: half * 0.6 };
}
