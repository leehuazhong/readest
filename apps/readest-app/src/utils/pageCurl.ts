/**
 * WebGL page-curl renderer (readest#555, mesh curl for Tauri apps).
 *
 * Draws a captured page bitmap as a grid mesh deformed around a cylinder —
 * the classic page curl: content before the fold stays flat, content past the
 * fold wraps over the cylinder and comes out mirrored on top, showing the
 * back of the page: the content bleeding through the theme paper (see
 * setBackdrop). The canvas is transparent wherever the page has curled
 * away, so the live (already turned) page shows through underneath.
 *
 * With two columns on screen (setColumns), only the outer column is a leaf:
 * it is hinged at the spine like a real book page, the fold stops at the
 * spine, and the leaf lands on the inner column as an exact mirror. Its back
 * shows the incoming page (setIncoming) so that the moment the overlay is
 * removed matches the live page underneath; without an incoming texture the
 * back is theme paper and the canvas fades out over the last stretch.
 *
 * The renderer knows nothing about capture or gestures: callers provide an
 * ImageBitmap of the outgoing page and drive `render(progress, grab)`.
 */

const VERTEX_SHADER = `
attribute vec2 aPos;      // page coords in [0,1]x[0,1]
uniform vec2 uPage;       // page size in px
uniform vec2 uFold;       // a point on the fold line, page px
uniform vec2 uDir;        // fold normal (unit): points toward the curled side
uniform float uRadius;    // cylinder radius, px
uniform vec2 uLeaf;       // open x interval (page px) of the leaf that may deform
uniform float uFlat;      // 1 = keep the mesh in place (cast-shadow pass)
varying vec2 vUv;
varying float vLift;      // 0 flat .. 1 on top of the cylinder / landed
varying float vShade;     // 0 flat or landed .. 1 at the top of the roll
varying float vS;         // signed distance past the fold line, page px

const float PI = 3.141592653589793;

void main() {
  vec2 p = aPos * uPage;
  float s = dot(p - uFold, uDir);
  float lift = 0.0;
  float shade = 0.0;
  // Vertices on the spine itself never move: they are the hinge shared with
  // the flat inner column, which must not stretch.
  if (uFlat < 0.5 && p.x > uLeaf.x && p.x < uLeaf.y && s > 0.0) {
    float r = max(uRadius, 1.0e-3);
    if (s < PI * r) {
      float wrapped = r * sin(s / r);
      float z = r * (1.0 - cos(s / r));
      p -= uDir * (s - wrapped);
      lift = z / (2.0 * r);
      shade = sin(s / r);
    } else {
      // Past the half turn: lies flat on top, mirrored about the fold. With
      // a zero radius this is an exact reflection, which is how a leaf lands
      // on the facing page.
      p -= uDir * (2.0 * s - PI * r);
      lift = 1.0;
    }
  }
  // Texture row 0 is the top of the captured page and aPos.y = 0 is the top
  // of the page, so page coordinates are texture coordinates as-is. Do NOT
  // rely on UNPACK_FLIP_Y_WEBGL to reconcile them: WebKit ignores it for
  // ImageBitmap uploads, which turned the curl upside down on iOS.
  vUv = aPos;
  vLift = lift;
  vShade = shade;
  vS = s;
  vec2 clip = (p / uPage) * 2.0 - 1.0;
  // Lifted parts draw on top of flat parts.
  gl_Position = vec4(clip.x, -clip.y, -vLift * 0.5, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTex;
uniform sampler2D uBack;
uniform sampler2D uIncoming;
uniform float uHasIncoming;
uniform vec2 uIncomingMap; // incoming u = uIncomingMap.x + uIncomingMap.y * page u
uniform float uCrease;     // 0 = swept fold (unchanged), 1 = finger-solved fold
uniform float uCreaseW;    // crease softness, page px
uniform float uShadow;     // 1 = this pass paints only the cast shadow
uniform float uShadowAmount;
uniform float uShadowW;    // how far the cast shadow reaches, page px
varying vec2 vUv;
varying float vLift;
varying float vShade;
varying float vS;

void main() {
  if (uShadow > 0.5) {
    // The raised sheet drops ambient shadow just beyond the crease, onto
    // whatever page is underneath — the live page, seen through the gap where
    // the turned sheet has lifted away. Drawn with the mesh undeformed, so the
    // shadow lands where the sheet used to be rather than where it went.
    float band = vS > 0.0 ? 1.0 - smoothstep(0.0, uShadowW, vS) : 0.0;
    gl_FragColor = vec4(0.0, 0.0, 0.0, uShadowAmount * band);
    return;
  }
  vec4 c = texture2D(uTex, vUv);
  // A finger-solved fold reads as paper because the flat sheet shades in
  // toward the crease. The folded back must NOT be shaded by the crease: it
  // stays the sheet's own mirrored content bleeding through the theme paper,
  // which is what makes the lifted leaf read as the reverse of this page
  // rather than a separate surface. Scaled by uCrease so the swept model
  // stays pixel-identical.
  float away = smoothstep(0.0, uCreaseW, max(0.0, -vS));
  if (gl_FrontFacing) {
    // Slight contact shading as the page lifts.
    c.rgb *= 1.0 - 0.18 * vLift;
    c.rgb *= mix(1.0, mix(0.62, 1.0, away), uCrease);
  } else if (uHasIncoming > 0.5) {
    // The back of a leaf: the incoming page, mirrored about the spine so it
    // reads correctly once the leaf has landed. Shaded only on the roll so
    // the landed part matches the live page pixel for pixel.
    c = texture2D(uIncoming, vec2(uIncomingMap.x + uIncomingMap.y * vUv.x, vUv.y));
    c.rgb *= 1.0 - 0.22 * vShade;
  } else {
    // The back of the page: the mirrored content bleeding through the
    // paper — the theme background supplied via setBackdrop.
    vec3 paper = texture2D(uBack, vUv).rgb;
    c.rgb = mix(c.rgb, paper, 0.72);
    c.rgb *= 1.0 - 0.08 * vLift;
  }
  gl_FragColor = vec4(c.rgb, c.a);
}
`;

const GRID = 64;
// Without an incoming texture a two-column leaf lands showing paper; fade the
// whole canvas over the last stretch so the live page takes over smoothly.
const LEAF_FADE_START = 0.8;
// Peak opacity of the shadow the raised sheet drops on the page underneath.
const CURL_SHADOW_AMOUNT = 0.34;

/**
 * How a turn draws its roll and the shadow it casts. Forward and backward each
 * keep their own: a reverse turn that reused the forward numbers read as the
 * same gesture played backwards, which is not what turning back looks like.
 */
export interface CurlRollStyle {
  /** Roll radius at progress 0, as a fraction of the leaf width. */
  radiusFrac: number;
  /** How much of that radius the turn has given back by progress 1. */
  radiusTaper: number;
  /** Peak opacity of the cast shadow. */
  shadowAmount: number;
}

/** The forward turn's roll — the numbers the swept model has always used. */
export const CURL_ROLL_DEFAULT: CurlRollStyle = {
  radiusFrac: 0.05,
  radiusTaper: 0.75,
  shadowAmount: CURL_SHADOW_AMOUNT,
};

/** A dragged backward turn: the roll tightens further as it lands and the
 *  sheet casts a heavier shadow, so reversing reads as its own gesture. */
export const CURL_ROLL_BACKWARD: CurlRollStyle = {
  radiusFrac: 0.05,
  radiusTaper: 0.85,
  shadowAmount: 0.4,
};

export interface CurlGrab {
  /** Normalized grab point on the page, 0..1 in both axes. */
  x: number;
  y: number;
}

/** A finger-solved fold: the sheet is folded so its lifted `corner` meets
 *  `finger`, which makes the crease the perpendicular bisector of the two. */
export interface CurlFoldInput {
  /** Normalized finger position on the page, 0..1 in both axes. */
  finger: CurlGrab;
  /** Normalized page corner the reader is holding, 0..1 in both axes. */
  corner: CurlGrab;
}

/** A solved crease: a point on the fold line, its unit normal, and how far
 *  across the sheet it has swept (0 at the corner, 1 at the far edge). */
export interface CurlFold {
  fold: [number, number];
  dir: [number, number];
  progress: number;
}

/** Finger travel that finishes a turn, as a multiple of the sheet's extent
 *  along the fold normal. Folding a corner flat onto the sheet spends one
 *  extent reaching the far edge while the crease only covers half the finger's
 *  motion, hence two. Lower values shorten the drag but stop matching where
 *  the crease actually is. */
export const CURL_FOLD_TRAVEL = 2;

/** The page corners, as (x, y) multipliers of the page size. */
const CURL_CORNERS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

/** How far the sheet reaches from (cx, cy) along the unit normal (nx, ny).
 *  A non-positive result means the direction points off the sheet. */
const foldExtent = (
  width: number,
  height: number,
  cx: number,
  cy: number,
  nx: number,
  ny: number,
) => {
  let extent = 0;
  for (const [ux, uy] of CURL_CORNERS) {
    extent = Math.max(extent, (ux * width - cx) * nx + (uy * height - cy) * ny);
  }
  return extent;
};

/**
 * Solve the crease for a finger-dragged corner.
 *
 * Paper folds flat, so the crease is the perpendicular bisector of the segment
 * from the held corner to the finger. Both the crease's position and its angle
 * are then continuous functions of the finger's two coordinates — the reader
 * can hold a half-fold and tilt it, which a one-dimensional sweep cannot
 * express. The crease starts at the corner and leaves the sheet after the
 * sheet's extent along the fold normal, so a full turn costs CURL_FOLD_TRAVEL
 * times that distance of finger travel, exactly as folding a corner in half
 * does.
 *
 * Returns null while the finger sits on (or behind) the corner — nothing is
 * folded yet — or when the drag points off the sheet.
 */
export const curlFoldFromFinger = (
  width: number,
  height: number,
  { finger, corner }: CurlFoldInput,
): CurlFold | null => {
  if (!(width > 0) || !(height > 0)) return null;
  const cx = corner.x * width;
  const cy = corner.y * height;
  const fx = finger.x * width;
  const fy = finger.y * height;
  const dx = fx - cx;
  const dy = fy - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;
  const nx = dx / dist;
  const ny = dy / dist;
  const extent = foldExtent(width, height, cx, cy, nx, ny);
  if (extent < 1) return null;
  return {
    fold: [(cx + fx) / 2, (cy + fy) / 2],
    // The shader deforms the s > 0 half, which is the sheet carrying the held
    // corner, so uDir points from the crease at the corner — the opposite of
    // the corner-to-finger normal used to measure the extent above. (The swept
    // model's normal likewise points from the crease at the grabbed edge.)
    dir: [-nx, -ny],
    progress: Math.min(1, dist / (CURL_FOLD_TRAVEL * extent)),
  };
};

/**
 * The finger position that makes `curlFoldFromFinger` report `progress`, for a
 * drag that keeps travelling along `direction` from `corner`. A release settle
 * tweens the finger through this so the derived sweep follows the same easing
 * curve the one-dimensional model used, while the crease keeps the angle the
 * reader released at.
 */
export const curlFingerAtProgress = (
  width: number,
  height: number,
  corner: CurlGrab,
  direction: CurlGrab,
  progress: number,
): CurlGrab | null => {
  if (!(width > 0) || !(height > 0)) return null;
  const cx = corner.x * width;
  const cy = corner.y * height;
  const dx = direction.x * width;
  const dy = direction.y * height;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  const nx = dx / length;
  const ny = dy / length;
  const extent = foldExtent(width, height, cx, cy, nx, ny);
  if (extent < 1) return null;
  const dist = progress * CURL_FOLD_TRAVEL * extent;
  return { x: corner.x + (nx * dist) / width, y: corner.y + (ny * dist) / height };
};

/**
 * How much of the sheet a dragged crease may sweep: its endpoint on the held
 * row has to stay at least this fraction of the sheet inside the held edge.
 * Below it, a finger that strays across the sheet drags the crease the whole
 * way in one gesture, and the sheet reads as folding sideways off the page
 * rather than turning.
 */
export const CURL_CREASE_LIMIT_FRAC = 0.24;

export interface CurlFoldLimitOptions {
  /**
   * Width of the sheet being turned: the page, or the outer column of a
   * two-column spread. Defaults to the page width.
   */
  leafWidth?: number;
  /**
   * Page x of the edge the folded half must stay clear of: the far page edge,
   * or the spine of a two-column spread. Defaults to the far page edge.
   */
  farX?: number;
  /** Override for {@link CURL_CREASE_LIMIT_FRAC}. */
  limitFrac?: number;
}

/**
 * Pull a dragged finger back along the pivot-to-finger ray until the crease it
 * solves obeys two limits:
 *
 *  1. the crease endpoint on the held row may not come further across than
 *     `limitFrac` of the sheet, so a long drag stops advancing the fold
 *     instead of sweeping the whole sheet in one gesture;
 *  2. the folded half may not contain either corner of `farX`. A crease that
 *     crosses the far edge hinges the sheet on the wrong side — the whole page
 *     folds sideways across itself, lifting the opposite corners, which is not
 *     something a held page does.
 *
 * Both are linear in the pull-back factor (the ray keeps its direction, so only
 * the crease's distance from the pivot changes), which makes the clamp a closed
 * form minimum rather than a search. When no legal pull-back exists — a drag
 * that crosses the held edge too little to fold anything legally — the finger
 * lands on the pivot and nothing is folded: the sheet stays put instead of
 * jumping to another fold model, the same way a straight vertical drag has
 * nothing to fold.
 *
 * A finger that is already legal is returned unchanged, so a clean horizontal
 * turn keeps its crease exactly where the one-dimensional model put it.
 */
export const clampCurlFinger = (
  width: number,
  height: number,
  { finger, corner }: CurlFoldInput,
  options: CurlFoldLimitOptions = {},
): CurlGrab => {
  if (!(width > 0) || !(height > 0)) return finger;
  const rightEdge = corner.x >= 0.5;
  const leafWidth = options.leafWidth ?? width;
  const farX = options.farX ?? (rightEdge ? 0 : width);
  const limitFrac = options.limitFrac ?? CURL_CREASE_LIMIT_FRAC;
  const cx = corner.x * width;
  const cy = corner.y * height;
  const dx = finger.x * width - cx;
  const dy = finger.y * height - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return finger;
  const nx = dx / dist;
  const ny = dy / dist;

  /** The largest crease distance from the pivot that `progress` allows. */
  const reachFor = (progress: number) => {
    // The visible crease sits half a roll beyond the bisector, and the roll
    // tightens as the sheet comes across (see the renderer's solved branch), so
    // the margin depends on how far the crease has swept.
    const roll = Math.max(1.5, 0.05 * leafWidth * (1 - 0.75 * progress));
    let reach =
      Math.abs(nx) > 1e-9 ? (1 - limitFrac) * leafWidth * Math.abs(nx) - (Math.PI * roll) / 2 : 0;
    for (const farY of [0, height]) {
      reach = Math.min(reach, (farX - cx) * nx + (farY - cy) * ny);
    }
    return reach;
  };

  const extent = Math.max(1, foldExtent(width, height, cx, cy, nx, ny));
  // The margin's own roll comes from the sweep it limits, so one refinement
  // pass lands the endpoint where it will actually be drawn.
  let reach = reachFor(Math.min(1, dist / (2 * extent)));
  reach = reachFor(Math.min(1, Math.max(0, reach) / extent));
  if (reach >= dist / 2) return finger;
  if (reach <= 0) return { ...corner };
  const pull = (reach * 2) / dist;
  return {
    x: corner.x + (dx * pull) / width,
    y: corner.y + (dy * pull) / height,
  };
};

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export class PageCurlRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private backTex: WebGLTexture | null = null;
  private incomingTex: WebGLTexture | null = null;
  private hasIncoming = false;
  private columns = 1;
  private indexCount = 0;
  private width = 0;
  private height = 0;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private preserveDrawingBuffer: boolean;

  constructor(options: { preserveDrawingBuffer?: boolean } = {}) {
    // Standalone pixel/readback users retain the historical default. The
    // captured-turn pipeline opts out because its idle surface can stay alive
    // much longer and redraws before reveal.
    this.preserveDrawingBuffer = options.preserveDrawingBuffer ?? true;
  }

  /** Mount the overlay canvas covering `rect` (CSS px) inside `container`. */
  attach(container: HTMLElement, width: number, height: number, dpr = window.devicePixelRatio) {
    this.width = width;
    this.height = height;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: `${width}px`,
      height: `${height}px`,
      pointerEvents: 'none',
      zIndex: '50',
    });
    container.appendChild(canvas);
    this.canvas = canvas;

    // preserveDrawingBuffer is only needed by readback callers. Long-lived
    // prepared turn surfaces disable it to avoid retaining another full-size
    // color buffer while idle.
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: this.preserveDrawingBuffer,
    });
    if (!gl) {
      this.dispose();
      throw new Error('WebGL unavailable');
    }
    this.gl = gl;

    const compile = (type: number, src: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
    }
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
    gl.useProgram(program);

    // Grid mesh of GRID x GRID quads over the unit page. GRID is even, so a
    // two-column spine falls on a grid line and no quad straddles the hinge.
    const verts: number[] = [];
    for (let y = 0; y <= GRID; y++) {
      for (let x = 0; x <= GRID; x++) {
        verts.push(x / GRID, y / GRID);
      }
    }
    const indices: number[] = [];
    const at = (x: number, y: number) => y * (GRID + 1) + x;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        indices.push(at(x, y), at(x + 1, y), at(x, y + 1));
        indices.push(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
      }
    }
    this.indexCount = indices.length;

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    for (const name of [
      'uPage',
      'uFold',
      'uDir',
      'uRadius',
      'uLeaf',
      'uTex',
      'uBack',
      'uIncoming',
      'uHasIncoming',
      'uIncomingMap',
      'uCrease',
      'uCreaseW',
      'uFlat',
      'uShadow',
      'uShadowAmount',
      'uShadowW',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform2f(this.uniforms['uPage']!, width, height);
    // Crease shading and the cast shadow are off until a finger-solved fold
    // arrives, so the swept model renders exactly as before.
    gl.uniform1f(this.uniforms['uCrease']!, 0);
    gl.uniform1f(this.uniforms['uCreaseW']!, Math.max(1, 0.13 * width));
    gl.uniform1f(this.uniforms['uFlat']!, 0);
    gl.uniform1f(this.uniforms['uShadow']!, 0);
    gl.uniform1f(this.uniforms['uShadowAmount']!, 0);
    gl.uniform1f(this.uniforms['uShadowW']!, Math.max(1, 0.22 * width));

    // Back-face paper on unit 1: plain white until setBackdrop supplies the
    // theme background.
    this.backTex = this.createPlaceholderTexture(gl, 1, [255, 255, 255, 255]);
    gl.uniform1i(this.uniforms['uBack']!, 1);
    // Incoming page on unit 2: unused until setIncoming supplies it.
    this.incomingTex = this.createPlaceholderTexture(gl, 2, [0, 0, 0, 0]);
    gl.uniform1i(this.uniforms['uIncoming']!, 2);
    gl.uniform1f(this.uniforms['uHasIncoming']!, 0);
    gl.uniform2f(this.uniforms['uIncomingMap']!, 0, 1);
    gl.activeTexture(gl.TEXTURE0);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    // The vertex shader flips Y into clip space, mirroring triangle winding:
    // the grid's quads come out clockwise, so declare CW as front-facing or
    // gl_FrontFacing (front page vs whitened back) is inverted.
    gl.frontFace(gl.CW);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private createPlaceholderTexture(gl: WebGLRenderingContext, unit: number, rgba: number[]) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(rgba),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Upload the captured page (drawn at progress 0 it exactly covers). */
  setTexture(source: TexImageSource) {
    const gl = this.gl;
    if (!gl) return;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Upload unflipped; the vertex shader samples page coordinates directly.
    // (WebKit ignores UNPACK_FLIP_Y_WEBGL for ImageBitmap sources, so any
    // orientation scheme built on it breaks on iOS.)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.uniforms['uTex']!, 0);
  }

  /** Paper drawn on the back of the page (theme background color + texture). */
  setBackdrop(source: TexImageSource) {
    const gl = this.gl;
    if (!gl || !this.backTex) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.backTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * How many page columns the captured page holds. With 2, only the outer
   * column turns, hinged at the spine (the middle of the page); the inner
   * column stays flat until the leaf lands on it.
   */
  setColumns(columns: number) {
    this.columns = columns >= 2 ? 2 : 1;
  }

  /**
   * The incoming page shown on the back of a two-column leaf: a capture of
   * the inner column of the page the live view has already turned to (the
   * column the leaf lands on), at the same height as the captured page.
   * `null` reverts to the paper back.
   */
  setIncoming(source: TexImageSource | null) {
    const gl = this.gl;
    if (!gl || !this.incomingTex) return;
    this.hasIncoming = source !== null;
    if (source) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.incomingTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  /**
   * Draw the curl at `progress` (0 = flat, 1 = fully turned). `grab` picks
   * where the reader lifted the page: y near 1 curls from the bottom corner
   * (a diagonal fold that straightens as the turn completes), y near 0.5
   * folds straight. `rtl` mirrors the direction: with rtl the page is
   * grabbed at its left edge.
   *
   * With `fold`, the crease is solved from the finger instead: the sheet is
   * folded so its held `corner` meets `finger`, and the solved sweep replaces
   * `progress`. That makes the crease track the finger in both axes rather
   * than sweeping one fixed direction by a scalar, which is what a held page
   * does under a finger.
   */
  render(
    progress: number,
    grab: CurlGrab = { x: 1, y: 0.5 },
    rtl = false,
    fold: CurlFoldInput | null = null,
    roll: CurlRollStyle = CURL_ROLL_DEFAULT,
  ) {
    const gl = this.gl;
    if (!gl) return;
    const { width: w, height: h } = this;
    const leaf = this.columns === 2;
    // The sheet being turned: the whole page, or the outer column of a
    // two-column spread.
    const leafWidth = leaf ? w / 2 : w;
    // Only the spine is a hinge; the outer edge (and a single page) is open.
    const leafMin = leaf && !rtl ? w / 2 : -1e9;
    const leafMax = leaf && rtl ? w / 2 : 1e9;

    const solved = fold ? curlFoldFromFinger(w, h, fold) : null;
    if (fold) {
      // A requested fold that cannot be solved — the finger is back on the
      // corner, or the drag has left the sheet — means nothing is folded.
      // Draw the sheet flat rather than falling back to a swept fold the
      // finger never asked for.
      progress = solved ? solved.progress : 0;
    }

    let dir: [number, number];
    let foldX: number;
    let foldY: number;
    let radius: number;
    if (solved) {
      dir = solved.dir;
      foldX = solved.fold[0];
      foldY = solved.fold[1];
      // Paper bends over a short roll and lies flat beyond it. A hairline
      // radius is what separates a fold from a rolling carpet, and it
      // tightens as the sheet comes across — at the rate this turn's own roll
      // asks for, so forward and backward do not land identically.
      radius = Math.max(1.5, roll.radiusFrac * leafWidth * (1 - roll.radiusTaper * progress));
    } else {
      // Fold normal: mostly horizontal, tilted by how far the grab sits from
      // the vertical middle. The tilt decays with progress — a corner grab
      // starts as a steep diagonal pinch at that corner and flattens out, so
      // the far side of the page stays flat early in the turn yet the whole
      // page still clears by the end.
      const tilt = (grab.y - 0.5) * 1.8 * (1 - progress);
      const dx = rtl ? -1 : 1;
      const len = Math.hypot(1, tilt);
      dir = [dx / len, tilt / len];

      let travel: number;
      if (leaf) {
        // The roll tightens all the way to nothing so the leaf lands flat on
        // the inner column, and the fold stops exactly at the spine.
        radius = 0.16 * leafWidth * (1 - progress * progress);
        travel = leafWidth;
      } else {
        // The cylinder tightens slightly as the page lifts off.
        radius = Math.max(24, 0.16 * w * (1 - 0.4 * progress));
        // The fold sweeps from the grabbed edge along the grab row; by progress 1
        // (tilt 0) it must cross the page plus the final half-circumference so
        // the spine-side column has fully wrapped off.
        const endRadius = Math.max(24, 0.16 * w * 0.6);
        travel = w + Math.PI * endRadius;
      }
      const start: [number, number] = [rtl ? 0 : w, grab.y * h];
      foldX = start[0] - dir[0] * travel * progress;
      foldY = start[1] - dir[1] * travel * progress;
    }

    // The leaf's back shows the incoming inner column mirrored about the
    // spine: page u in [0.5, 1] maps to incoming u in [1, 0] for a right
    // leaf, page u in [0, 0.5] to incoming u in [1, 0] for a left leaf.
    const showIncoming = leaf && this.hasIncoming;
    gl.uniform1f(this.uniforms['uHasIncoming']!, showIncoming ? 1 : 0);
    gl.uniform2f(this.uniforms['uIncomingMap']!, rtl ? 1 : 2, -2);
    gl.uniform2f(this.uniforms['uLeaf']!, leafMin, leafMax);
    gl.uniform1f(this.uniforms['uCrease']!, solved ? 1 : 0);
    gl.uniform1f(this.uniforms['uCreaseW']!, Math.max(1, 0.13 * leafWidth));
    if (this.canvas) {
      const opacity = leaf && !this.hasIncoming ? 1 - smoothstep(LEAF_FADE_START, 1, progress) : 1;
      this.canvas.style.opacity = opacity < 1 ? String(opacity) : '';
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform2f(this.uniforms['uFold']!, foldX, foldY);
    gl.uniform2f(this.uniforms['uDir']!, dir[0], dir[1]);
    gl.uniform1f(this.uniforms['uRadius']!, radius);

    if (solved) {
      // The raised sheet's cast shadow, painted first and with the mesh held
      // flat so it falls where the sheet used to be — the live page underneath.
      // Depth testing is off because this is a background layer the sheet then
      // blends over; with it off no depth is written either.
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1f(this.uniforms['uFlat']!, 1);
      gl.uniform1f(this.uniforms['uShadow']!, 1);
      gl.uniform1f(
        this.uniforms['uShadowAmount']!,
        // Nothing is lifted yet at 0, and by 1 the sheet has turned right over
        // and no longer shadows the page it left. The final frame must be
        // fully transparent so removing the overlay cannot flash.
        roll.shadowAmount * Math.min(1, progress * 3) * (1 - progress),
      );
      gl.uniform1f(this.uniforms['uShadowW']!, Math.max(1, 0.22 * leafWidth));
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.uniform1f(this.uniforms['uFlat']!, 0);
      gl.uniform1f(this.uniforms['uShadow']!, 0);
    }

    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
  }

  /** Read back a pixel (device px, origin top-left) — used by tests. */
  readPixel(x: number, y: number): [number, number, number, number] {
    const gl = this.gl;
    const canvas = this.canvas;
    if (!gl || !canvas) return [0, 0, 0, 0];
    const data = new Uint8Array(4);
    gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return [data[0]!, data[1]!, data[2]!, data[3]!];
  }

  /** The canvas opacity the last render applied ('' when fully opaque). */
  get canvasOpacity(): string {
    return this.canvas?.style.opacity ?? '';
  }

  /** An idle prepared surface may lose its WebGL context under memory pressure. */
  isUsable() {
    return !!this.gl && !this.gl.isContextLost();
  }

  dispose() {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas?.remove();
    this.canvas = null;
    this.gl = null;
  }
}
