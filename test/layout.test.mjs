import assert from "node:assert/strict";
import test from "node:test";
import { placeRing, ringRadii } from "../src/engine/layout.ts";

test("placeRing spreads N nodes evenly, first at 12 o'clock (-PI/2), clockwise", () => {
  const pts = placeRing(4, 100, 0, 0);
  assert.equal(pts.length, 4);
  // first point due north
  assert.ok(Math.abs(pts[0].x - 0) < 1e-9);
  assert.ok(Math.abs(pts[0].y - -100) < 1e-9);
  // clockwise: second point due east (+x)
  assert.ok(pts[1].x > 99.9);
  assert.ok(Math.abs(pts[1].y) < 1e-9);
  // all on the circle of given radius about (cx,cy)
  for (const p of pts) assert.ok(Math.abs(Math.hypot(p.x, p.y) - 100) < 1e-9);
});

test("placeRing respects center offset", () => {
  const [p] = placeRing(1, 50, 200, 150);
  assert.ok(Math.abs(p.x - 200) < 1e-9);
  assert.ok(Math.abs(p.y - (150 - 50)) < 1e-9);
});

test("placeRing returns [] for an empty ring", () => {
  assert.deepEqual(placeRing(0, 100, 0, 0), []);
});

test("ringRadii gives inner < outer, both inside the viewport", () => {
  const { inner, outer } = ringRadii(400);
  assert.ok(inner > 0 && inner < outer);
  assert.ok(outer < 200); // within half of a 400px box
});
