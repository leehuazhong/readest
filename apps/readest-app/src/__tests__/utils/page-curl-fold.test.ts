import { describe, it, expect } from 'vitest';
import {
  CURL_CREASE_LIMIT_FRAC,
  clampCurlFinger,
  curlFingerAtProgress,
  curlFoldFromFinger,
} from '@/utils/pageCurl';

// The crease is the perpendicular bisector of the segment from the held page
// corner to the finger, so a held sheet follows the finger in BOTH axes. A
// one-dimensional sweep by a scalar cannot express that: the same horizontal
// drag must produce a different fold once the finger also moves vertically.
// These pin the geometry only; rendering is covered by
// page-curl.browser.test.ts.
const W = 400;
const H = 300;
const BOTTOM_RIGHT = { x: 1, y: 1 };

describe('curlFoldFromFinger', () => {
  it('puts the crease half way between the corner and the finger', () => {
    const fold = curlFoldFromFinger(W, H, { finger: { x: 0.5, y: 1 }, corner: BOTTOM_RIGHT })!;
    expect(fold.fold[0]).toBeCloseTo(300, 6);
    expect(fold.fold[1]).toBeCloseTo(300, 6);
  });

  it('points the fold normal at the held corner, not at the finger', () => {
    // The renderer deforms the s > 0 half, so a normal aimed at the finger
    // would fold the sheet onto the wrong side of the crease.
    const fold = curlFoldFromFinger(W, H, { finger: { x: 0.5, y: 1 }, corner: BOTTOM_RIGHT })!;
    const towardCorner = (W - fold.fold[0]) * fold.dir[0] + (H - fold.fold[1]) * fold.dir[1];
    expect(towardCorner).toBeGreaterThan(0);
    expect(fold.dir[0]).toBeCloseTo(1, 6);
    expect(fold.dir[1]).toBeCloseTo(0, 6);
  });

  it('folds nothing while the finger is on the corner', () => {
    expect(curlFoldFromFinger(W, H, { finger: { x: 1, y: 1 }, corner: BOTTOM_RIGHT })).toBeNull();
  });

  it('folds nothing when the drag points off the sheet', () => {
    // Beyond the corner, away from the page: the fold normal would face
    // outward, so the crease has no sheet left to sweep.
    expect(
      curlFoldFromFinger(W, H, { finger: { x: 1.5, y: 1.5 }, corner: BOTTOM_RIGHT }),
    ).toBeNull();
  });

  it('reports half the page at half the travel to the far edge', () => {
    const fold = curlFoldFromFinger(W, H, { finger: { x: 0, y: 1 }, corner: BOTTOM_RIGHT })!;
    expect(fold.progress).toBeCloseTo(0.5, 6);
    expect(fold.fold[0]).toBeCloseTo(200, 6);
  });

  it('finishes exactly when the crease leaves the sheet', () => {
    // The crease reaches the far edge (x = 0) when the corner has been
    // dragged to its mirror a full page width past it.
    const done = curlFoldFromFinger(W, H, { finger: { x: -1, y: 1 }, corner: BOTTOM_RIGHT })!;
    expect(done.progress).toBe(1);
    expect(done.fold[0]).toBeCloseTo(0, 6);
  });

  it('tilts the crease when the finger moves vertically', () => {
    const flat = curlFoldFromFinger(W, H, { finger: { x: 0.5, y: 0.5 }, corner: BOTTOM_RIGHT })!;
    const tilted = curlFoldFromFinger(W, H, { finger: { x: 0.5, y: 0.8 }, corner: BOTTOM_RIGHT })!;
    // Same horizontal drag, different vertical position: both the crease
    // angle and how far it has swept must differ.
    expect(tilted.dir[0]).not.toBeCloseTo(flat.dir[0], 3);
    expect(tilted.dir[1]).not.toBeCloseTo(flat.dir[1], 3);
    expect(tilted.progress).not.toBeCloseTo(flat.progress, 3);
  });

  it('stays continuous as the finger crosses the page', () => {
    // A corner chosen per-sample from the finger's half of the page would snap
    // at the middle. The solved crease only ever follows the finger, so across
    // a scan its step is exactly half the finger's step — a jump would blow
    // this up by orders of magnitude.
    const stepX = W / 100;
    const stepY = H / 400;
    let worst = 0;
    let previous: { fold: [number, number] } | null = null;
    for (let i = 0; i <= 200; i++) {
      const current = curlFoldFromFinger(W, H, {
        finger: { x: 1 - i / 100, y: 1 - i / 400 },
        corner: BOTTOM_RIGHT,
      });
      if (previous && current) {
        worst = Math.max(
          worst,
          Math.hypot(current.fold[0] - previous.fold[0], current.fold[1] - previous.fold[1]),
        );
      }
      previous = current;
    }
    expect(worst).toBeCloseTo(Math.hypot(stepX, stepY) / 2, 3);
  });

  it('rejects degenerate page geometry instead of dividing by zero', () => {
    expect(curlFoldFromFinger(0, H, { finger: { x: 0.5, y: 1 }, corner: BOTTOM_RIGHT })).toBeNull();
    expect(curlFoldFromFinger(W, 0, { finger: { x: 0.5, y: 1 }, corner: BOTTOM_RIGHT })).toBeNull();
  });
});

// A release settle must keep the crease angle the reader let go at while the
// sweep plays out, so it tweens the finger rather than the fold.
describe('curlFingerAtProgress', () => {
  const DIRECTION = { x: -0.8, y: -0.6 };

  it('round-trips through the solver at every progress', () => {
    for (const progress of [0.05, 0.25, 0.5, 0.75, 1]) {
      const finger = curlFingerAtProgress(W, H, BOTTOM_RIGHT, DIRECTION, progress)!;
      const solved = curlFoldFromFinger(W, H, { finger, corner: BOTTOM_RIGHT })!;
      expect(solved.progress).toBeCloseTo(progress, 6);
    }
  });

  it('holds the released crease angle across the whole settle', () => {
    const at = (progress: number) =>
      curlFoldFromFinger(W, H, {
        finger: curlFingerAtProgress(W, H, BOTTOM_RIGHT, DIRECTION, progress)!,
        corner: BOTTOM_RIGHT,
      })!;
    expect(at(1).dir[0]).toBeCloseTo(at(0.2).dir[0], 6);
    expect(at(1).dir[1]).toBeCloseTo(at(0.2).dir[1], 6);
  });

  it('refuses a direction that points off the sheet', () => {
    // From the bottom-right corner, a pull further right/down folds nothing.
    expect(curlFingerAtProgress(W, H, BOTTOM_RIGHT, { x: 1, y: 1 }, 0.5)).toBeNull();
  });
});

// A dragged curl must not be able to fold the sheet sideways: the finger is
// clamped along the pivot-to-finger ray so the crease keeps to the held side of
// the page, and so a long stray drag stops advancing the fold rather than
// sweeping the whole sheet across in one gesture.
describe('clampCurlFinger', () => {
  // A phone-shaped page: the reported strays are tall, so the aspect ratio is
  // part of the case (the solver tests above use a landscape page).
  const PW = 320;
  const PH = 640;
  const LIMIT_X = CURL_CREASE_LIMIT_FRAC * PW;
  const RIGHT = { x: 1, y: 0.5 };
  type Solved = { fold: [number, number]; dir: [number, number] };
  /** Signed distance of `point` from the crease, positive on the folded side. */
  const foldSide = (fold: Solved, point: [number, number]) =>
    (point[0] - fold.fold[0]) * fold.dir[0] + (point[1] - fold.fold[1]) * fold.dir[1];
  /** Where the crease crosses the held row: the endpoint the limits judge. */
  const creaseX = (fold: Solved, heldY: number) =>
    fold.fold[0] - (fold.dir[1] * (heldY - fold.fold[1])) / fold.dir[0];

  it('leaves a clean horizontal turn exactly where it was', () => {
    const finger = { x: 0.3, y: 0.5 };
    expect(clampCurlFinger(PW, PH, { finger, corner: RIGHT })).toEqual(finger);
  });

  it('keeps the folded half clear of both far corners', () => {
    for (const heldY of [0.15, 0.5, 0.85]) {
      const corner = { x: 1, y: heldY };
      for (let across = 1; across <= 9; across++) {
        for (const stray of [-0.3, -0.15, 0.15, 0.3]) {
          const finger = { x: across / 10, y: heldY + stray };
          const clamped = clampCurlFinger(PW, PH, { finger, corner });
          const fold = curlFoldFromFinger(PW, PH, { finger: clamped, corner });
          if (!fold) continue;
          const where = `held ${heldY} finger ${across},${stray}`;
          expect(foldSide(fold, [0, 0]), where).toBeLessThanOrEqual(1e-6);
          expect(foldSide(fold, [0, PH]), where).toBeLessThanOrEqual(1e-6);
        }
      }
    }
  });

  it('stops the crease endpoint at the limit instead of sweeping past it', () => {
    const corner = { x: 1, y: 1 };
    const raw = { x: 260 / PW, y: 460 / PH };
    const rawFold = curlFoldFromFinger(PW, PH, { finger: raw, corner })!;
    expect(creaseX(rawFold, PH)).toBeLessThan(LIMIT_X - 2);

    const clamped = clampCurlFinger(PW, PH, { finger: raw, corner });
    const fold = curlFoldFromFinger(PW, PH, { finger: clamped, corner })!;
    expect(creaseX(fold, PH)).toBeGreaterThan(LIMIT_X - 2);
    // The pull-back rides the drag's own ray, so the crease keeps its angle and
    // the fold only loses travel.
    expect(fold.dir[0]).toBeCloseTo(rawFold.dir[0], 6);
    expect(fold.dir[1]).toBeCloseTo(rawFold.dir[1], 6);
    expect(clamped.x).toBeGreaterThan(raw.x);
  });

  it('folds nothing when a stray drag has no legal crease left', () => {
    // The drag that surfaced this: hold the edge at 58% height, stray a little
    // up. The crease would run corner to corner and lift the opposite corner.
    const corner = { x: 1, y: 374 / PH };
    const clamped = clampCurlFinger(PW, PH, { finger: { x: 278 / PW, y: 433 / PH }, corner });
    expect(clamped).toEqual(corner);
    expect(curlFoldFromFinger(PW, PH, { finger: clamped, corner })).toBeNull();
  });

  it('mirrors for a left-edge grab', () => {
    for (const finger of [
      { x: 0.4, y: 0.5 },
      { x: 0.6, y: 0.3 },
      { x: 0.6, y: 0.9 },
    ]) {
      const right = clampCurlFinger(PW, PH, { finger, corner: RIGHT });
      const left = clampCurlFinger(PW, PH, {
        finger: { x: 1 - finger.x, y: finger.y },
        corner: { x: 0, y: 0.5 },
      });
      expect(left.x).toBeCloseTo(1 - right.x, 6);
      expect(left.y).toBeCloseTo(right.y, 6);
    }
  });

  it('keeps a two-column leaf inside its spine', () => {
    // A spread turns one leaf, so the crease may not cross the spine even
    // though the spine is well inside the captured page.
    const options = { leafWidth: PW / 2, farX: PW / 2 };
    for (let across = 1; across <= 9; across++) {
      const corner = { x: 1, y: 0.5 };
      const finger = { x: across / 10, y: 0.5 + across / 20 };
      const clamped = clampCurlFinger(PW, PH, { finger, corner }, options);
      const fold = curlFoldFromFinger(PW, PH, { finger: clamped, corner });
      if (!fold) continue;
      expect(foldSide(fold, [PW / 2, 0]), `across ${across}`).toBeLessThanOrEqual(1e-6);
      expect(foldSide(fold, [PW / 2, PH]), `across ${across}`).toBeLessThanOrEqual(1e-6);
    }
  });

  it('rejects degenerate page geometry', () => {
    const finger = { x: 0.4, y: 0.5 };
    expect(clampCurlFinger(0, PH, { finger, corner: RIGHT })).toEqual(finger);
    expect(clampCurlFinger(PW, 0, { finger, corner: RIGHT })).toEqual(finger);
  });
});
