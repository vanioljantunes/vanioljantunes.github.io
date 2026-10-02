/* X-ray to volume registration, in the browser.

   A WebGL2 reimplementation of the forward model used by nanoDRR and by the
   `xvr register` step: a digitally reconstructed radiograph is the line
   integral of linear attenuation along every source-to-detector ray, and the
   pose is recovered by maximising normalised cross-correlation between the
   moving DRR and a fixed radiograph.

   The trained pose regressor of XVR is a PyTorch model and does not run here;
   this page is the differentiable-rendering half of the method. */

const VOL_URL = '/imaging/xvr/ct-volume.bin';
const META_URL = '/imaging/xvr/ct-volume.json';

/* C-arm geometry, in millimetres. */
const SID = 700;          // source to isocentre
const SDD = 1050;         // source to detector
const DET_MM = 450;       // detector side length
const ISO_OFFSET = [0, 0, -85];   // isocentre inside the volume, over the pelvis

/* Registration search. */
const SCALES = [
  { size: 64, iters: 130 },
  { size: 112, iters: 90 },
];
const EPS_ROT = 0.25;     // degrees, for the central difference
const EPS_TRA = 0.5;      // millimetres
const LR0 = 0.9;
const LR_DECAY = 0.988;
const LR_MIN = 0.06;

const PARAMS = [
  { key: 'rx', label: 'Rotation X', unit: '°', min: -35, max: 35, step: 0.1 },
  { key: 'ry', label: 'Rotation Y', unit: '°', min: -35, max: 35, step: 0.1 },
  { key: 'rz', label: 'Rotation Z', unit: '°', min: -35, max: 35, step: 0.1 },
  { key: 'tx', label: 'Translation X', unit: ' mm', min: -80, max: 80, step: 0.5 },
  { key: 'ty', label: 'Translation Y', unit: ' mm', min: -80, max: 80, step: 0.5 },
  { key: 'tz', label: 'Translation Z', unit: ' mm', min: -80, max: 80, step: 0.5 },
];

/* ---------------------------------------------------------------- shaders */

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_DRR = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform vec3 uHalf;      // half extent of the volume, mm
uniform vec3 uIso;       // isocentre in volume-centred coordinates, mm
uniform vec3 uSrc;       // source position, world mm
uniform vec3 uDetC;      // detector centre, world mm
uniform vec3 uDetX;      // detector row axis, unit
uniform vec3 uDetY;      // detector column axis, unit
uniform float uDet;      // detector side, mm
uniform float uMu;       // attenuation per stored unit, 1/mm
uniform int uSteps;
in vec2 vUV;
out vec4 outColor;

void main() {
  vec2 pd = (vUV - 0.5) * uDet;
  vec3 target = uDetC + uDetX * pd.x + uDetY * pd.y;
  vec3 dir = normalize(target - uSrc);
  vec3 o = uSrc + uIso;    // ray origin in volume-centred coordinates

  vec3 safe = mix(dir, vec3(1e-6), lessThan(abs(dir), vec3(1e-6)));
  vec3 inv = 1.0 / safe;
  vec3 ta = (-uHalf - o) * inv;
  vec3 tb = (uHalf - o) * inv;
  vec3 tlo = min(ta, tb);
  vec3 thi = max(ta, tb);
  float tn = max(max(tlo.x, tlo.y), tlo.z);
  float tf = min(min(thi.x, thi.y), thi.z);

  float sum = 0.0;
  if (tf > tn) {
    tn = max(tn, 0.0);
    float ds = (tf - tn) / float(uSteps);
    for (int i = 0; i < 1024; i++) {
      if (i >= uSteps) break;
      vec3 p = o + dir * (tn + (float(i) + 0.5) * ds);
      sum += texture(uVol, (p + uHalf) / (2.0 * uHalf)).r;
    }
    sum *= uMu * ds;
  }
  outColor = vec4(sum, 0.0, 0.0, 1.0);
}`;

const FRAG_SHOW = `#version 300 es
precision highp float;
uniform sampler2D uImg;
uniform vec2 uWindow;   // line integral mapped to black and to white
in vec2 vUV;
out vec4 outColor;
float tone(float raw) {
  return pow(clamp((raw - uWindow.x) / max(uWindow.y - uWindow.x, 1e-6), 0.0, 1.0), 1.35);
}
void main() {
  float v = tone(texture(uImg, vUV).r);
  outColor = vec4(v, v, v, 1.0);
}`;

const FRAG_DIFF = `#version 300 es
precision highp float;
uniform sampler2D uFixed;
uniform sampler2D uMoving;
uniform vec2 uWindow;
in vec2 vUV;
out vec4 outColor;
float tone(float raw) {
  return pow(clamp((raw - uWindow.x) / max(uWindow.y - uWindow.x, 1e-6), 0.0, 1.0), 1.35);
}
void main() {
  float a = tone(texture(uFixed, vUV).r);
  float b = tone(texture(uMoving, vUV).r);
  outColor = vec4(a, b, b, 1.0);
}`;

/* ------------------------------------------------------------ small maths */

const rad = (d) => (d * Math.PI) / 180;

function rotation(rx, ry, rz) {
  const cx = Math.cos(rad(rx));
  const sx = Math.sin(rad(rx));
  const cy = Math.cos(rad(ry));
  const sy = Math.sin(rad(ry));
  const cz = Math.cos(rad(rz));
  const sz = Math.sin(rad(rz));
  // Rz * Ry * Rx, row major
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

const apply = (R, v) => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];

function mul(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    }
  }
  return C;
}

/* Camera at rest: the beam runs along the patient's y axis and the detector
   column axis is +z, so the top of the image is superior. */
const R_BASE = [1, 0, 0, 0, 0, -1, 0, 1, 0];

function geometry(p) {
  const R = mul(rotation(p[0], p[1], p[2]), R_BASE);
  const t = [p[3], p[4], p[5]];
  return {
    R,
    src: apply(R, [0, 0, -SID]).map((v, i) => v + t[i]),
    det: apply(R, [0, 0, SDD - SID]).map((v, i) => v + t[i]),
    ex: apply(R, [1, 0, 0]),
    ey: apply(R, [0, 1, 0]),
  };
}

/* Geodesic angle between two pose rotations, in degrees. */
function rotationError(a, b) {
  const A = mul(rotation(a[0], a[1], a[2]), R_BASE);
  const B = mul(rotation(b[0], b[1], b[2]), R_BASE);
  let tr = 0;
  for (let i = 0; i < 9; i++) {
    const r = Math.floor(i / 3);
    const c = i % 3;
    tr += A[r * 3 + c] * B[r * 3 + c];
  }
  return (Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180) / Math.PI;
}

const translationError = (a, b) =>
  Math.hypot(a[3] - b[3], a[4] - b[4], a[5] - b[5]);

function ncc(a, b) {
  const n = a.length;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    num += da * db;
    va += da * da;
    vb += db * db;
  }
  const den = Math.sqrt(va * vb);
  return den > 1e-9 ? num / den : 0;
}

/* -------------------------------------------------------------- rendering */

function makeProgram(gl, vsrc, fsrc) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsrc));
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
  }
  const loc = {};
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(program, i).name;
    loc[name] = gl.getUniformLocation(program, name);
  }
  return { program, loc };
}

class Renderer {
  constructor(gl, meta, data) {
    this.gl = gl;
    this.meta = meta;
    this.half = meta.dims.map((d, i) => (d * meta.spacing_mm[i]) / 2);
    this.programs = {
      drr: makeProgram(gl, VERT, FRAG_DRR),
      show: makeProgram(gl, VERT, FRAG_SHOW),
      diff: makeProgram(gl, VERT, FRAG_DIFF),
    };

    const quad = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.volume = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.volume);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const axis of ['TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'TEXTURE_WRAP_R']) {
      gl.texParameteri(gl.TEXTURE_3D, gl[axis], gl.CLAMP_TO_EDGE);
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, meta.dims[0], meta.dims[1], meta.dims[2],
      0, gl.RED, gl.UNSIGNED_BYTE, data);

    this.buffers = new Map();
  }

  /* Named off-screen float buffers, so the fixed and moving images can share
     a size without sharing a texture. */
  buffer(name, width, height) {
    const existing = this.buffers.get(name);
    if (existing && existing.width === width && existing.height === height) return existing;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    // Float textures are only filterable with OES_texture_float_linear, which
    // is not needed here: every sample is one to one with a texel.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const entry = { tex, fbo, width, height, pixels: new Float32Array(width * height * 4) };
    this.buffers.set(name, entry);
    return entry;
  }

  /* One DRR into the given viewport of whatever target is bound. */
  drawDRR(pose, steps, x, y, w, h) {
    const gl = this.gl;
    const p = this.programs.drr;
    const g = geometry(pose);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volume);
    gl.uniform1i(p.loc.uVol, 0);
    gl.uniform3fv(p.loc.uHalf, this.half);
    gl.uniform3fv(p.loc.uIso, ISO_OFFSET);
    gl.uniform3fv(p.loc.uSrc, g.src);
    gl.uniform3fv(p.loc.uDetC, g.det);
    gl.uniform3fv(p.loc.uDetX, g.ex);
    gl.uniform3fv(p.loc.uDetY, g.ey);
    gl.uniform1f(p.loc.uDet, DET_MM);
    gl.uniform1f(p.loc.uMu, this.meta.mu_max_per_mm / 255);
    gl.uniform1i(p.loc.uSteps, steps);
    gl.viewport(x, y, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  renderInto(entry, pose, steps) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, entry.fbo);
    this.drawDRR(pose, steps, 0, 0, entry.width, entry.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  readback(entry) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, entry.fbo);
    gl.readPixels(0, 0, entry.width, entry.height, gl.RGBA, gl.FLOAT, entry.pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return entry.pixels;
  }

  show(entry, window) {
    const gl = this.gl;
    const p = this.programs.show;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.uniform1i(p.loc.uImg, 0);
    gl.uniform2fv(p.loc.uWindow, window);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  showDiff(fixed, moving, window) {
    const gl = this.gl;
    const p = this.programs.diff;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fixed.tex);
    gl.uniform1i(p.loc.uFixed, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, moving.tex);
    gl.uniform1i(p.loc.uMoving, 1);
    gl.uniform2fv(p.loc.uWindow, window);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/* ------------------------------------------------------------------ page */

const el = (id) => document.getElementById(id);

const state = {
  truth: [0, 0, 0, 0, 0, 0],
  pose: [0, 0, 0, 0, 0, 0],
  window: [0, 1],
  running: false,
  iteration: 0,
  ncc: 0,
  history: [],
  elapsed: 0,
};

let renderer = null;
let panels = null;
const fixedSmall = new Map();   // metric size -> Float32Array of the fixed image
const scratch = new Map();      // metric size -> reusable gather buffer
let displaySize = 320;
let displaySteps = 384;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const setStatus = (text) => { el('xvr-status').textContent = text; };

function randomTruth() {
  const r = (m) => (Math.random() * 2 - 1) * m;
  return [r(9), r(14), r(7), r(18), r(22), r(18)];
}

function perturbed(truth) {
  const r = (m) => (Math.random() * 2 - 1) * m;
  return truth.map((v, i) => v + (i < 3 ? r(7) : r(16)));
}

function syncSliders() {
  PARAMS.forEach((p, i) => {
    el(`xvr-${p.key}`).value = String(state.pose[i]);
    el(`xvr-${p.key}-out`).textContent = state.pose[i].toFixed(1) + p.unit;
  });
}

function updateReadouts() {
  el('xvr-ncc').textContent = state.ncc.toFixed(4);
  el('xvr-iter').textContent = String(state.iteration);
  el('xvr-rot').textContent = rotationError(state.pose, state.truth).toFixed(2) + '°';
  el('xvr-tra').textContent = translationError(state.pose, state.truth).toFixed(1) + ' mm';
  el('xvr-time').textContent = state.elapsed ? (state.elapsed / 1000).toFixed(1) + ' s' : '—';
}

function drawHistory() {
  const canvas = el('xvr-plot');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  ctx.strokeStyle = css.getPropertyValue('--border').trim() || '#c9d0d9';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  const pts = state.history;
  if (pts.length < 2) return;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = Math.max(hi - lo, 1e-4);
  ctx.strokeStyle = css.getPropertyValue('--accent').trim() || '#1d5fb8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = 4 + (i / (pts.length - 1)) * (w - 8);
    const y = h - 4 - ((v - lo) / span) * (h - 8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

const blit = (canvas) => {
  canvas.getContext('2d').drawImage(renderer.gl.canvas, 0, 0, canvas.width, canvas.height);
};

function paint() {
  const moving = renderer.buffer('moving', displaySize, displaySize);
  renderer.renderInto(moving, state.pose, displaySteps);
  renderer.show(moving, state.window);
  blit(panels.moving);
  renderer.showDiff(renderer.buffer('fixed', displaySize, displaySize), moving, state.window);
  blit(panels.overlay);
}

/* Pulls one tile out of the packed read-back buffer. */
function gather(pixels, rowLen, col, row, size) {
  let buf = scratch.get(size);
  if (!buf) {
    buf = new Float32Array(size * size);
    scratch.set(size, buf);
  }
  for (let y = 0; y < size; y++) {
    const base = ((row * size + y) * rowLen + col * size) * 4;
    for (let x = 0; x < size; x++) buf[y * size + x] = pixels[base + x * 4];
  }
  return buf;
}

/* A radiograph needs a window, not a plain divide by the maximum: the line
   integral through soft tissue crowds the top of the range. */
function windowFrom(pixels) {
  const sample = [];
  for (let i = 0; i < pixels.length; i += 16) sample.push(pixels[i]);
  sample.sort((a, b) => a - b);
  const at = (q) => sample[Math.min(sample.length - 1, Math.round(q * (sample.length - 1)))];
  const lo = at(0.30);
  const hi = at(0.999);
  return hi > lo ? [lo, hi] : [0, Math.max(hi, 1e-6)];
}

function renderFixed() {
  const fixed = renderer.buffer('fixed', displaySize, displaySize);
  renderer.renderInto(fixed, state.truth, displaySteps);
  state.window = windowFrom(renderer.readback(fixed));
  renderer.show(fixed, state.window);
  blit(panels.fixed);

  fixedSmall.clear();
  for (const scale of SCALES) {
    const small = renderer.buffer(`fixed${scale.size}`, scale.size, scale.size);
    renderer.renderInto(small, state.truth, 256);
    const raw = renderer.readback(small);
    const flat = new Float32Array(scale.size * scale.size);
    for (let i = 0; i < flat.length; i++) flat[i] = raw[i * 4];
    fixedSmall.set(scale.size, flat);
  }
}

/* Thirteen poses per iteration, tiled into one buffer and read back once. */
function costAndGradient(pose, size) {
  const gl = renderer.gl;
  const tile = renderer.buffer('tiles', size * 4, size * 4);
  const poses = [pose.slice()];
  for (let k = 0; k < 6; k++) {
    const eps = k < 3 ? EPS_ROT : EPS_TRA;
    const up = pose.slice();
    const down = pose.slice();
    up[k] += eps;
    down[k] -= eps;
    poses.push(up, down);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, tile.fbo);
  poses.forEach((p, i) => {
    renderer.drawDRR(p, 256, (i % 4) * size, Math.floor(i / 4) * size, size, size);
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const px = renderer.readback(tile);

  const fixed = fixedSmall.get(size);
  const costs = poses.map((_, i) =>
    1 - ncc(gather(px, size * 4, i % 4, Math.floor(i / 4), size), fixed));

  const grad = new Array(6);
  for (let k = 0; k < 6; k++) {
    const eps = k < 3 ? EPS_ROT : EPS_TRA;
    grad[k] = (costs[1 + 2 * k] - costs[2 + 2 * k]) / (2 * eps);
  }
  return { cost: costs[0], grad };
}

function makeOptimiser() {
  const m = new Array(6).fill(0);
  const v = new Array(6).fill(0);
  let step = 0;
  let scaleIndex = 0;
  let inScale = 0;
  let lr = LR0;
  const started = performance.now();

  return function iterate() {
    const scale = SCALES[scaleIndex];
    const { cost, grad } = costAndGradient(state.pose, scale.size);
    step += 1;
    const b1 = 0.9;
    const b2 = 0.999;
    for (let k = 0; k < 6; k++) {
      m[k] = b1 * m[k] + (1 - b1) * grad[k];
      v[k] = b2 * v[k] + (1 - b2) * grad[k] * grad[k];
      const mh = m[k] / (1 - Math.pow(b1, step));
      const vh = v[k] / (1 - Math.pow(b2, step));
      const next = state.pose[k] - (lr * mh) / (Math.sqrt(vh) + 1e-8);
      state.pose[k] = Math.min(PARAMS[k].max, Math.max(PARAMS[k].min, next));
    }
    lr = Math.max(LR_MIN, lr * LR_DECAY);
    state.ncc = 1 - cost;
    state.iteration += 1;
    state.history.push(state.ncc);
    state.elapsed = performance.now() - started;

    inScale += 1;
    if (inScale >= scale.iters) {
      inScale = 0;
      scaleIndex += 1;
    }
    return scaleIndex < SCALES.length;
  };
}

let optimiser = null;

function finishedMessage() {
  return `Converged after ${state.iteration} iterations. Rotation error ` +
    `${rotationError(state.pose, state.truth).toFixed(2)}°, translation error ` +
    `${translationError(state.pose, state.truth).toFixed(1)} mm.`;
}

function stopRun(message) {
  state.running = false;
  optimiser = null;
  el('xvr-register').disabled = false;
  el('xvr-stop').disabled = true;
  syncSliders();
  paint();
  updateReadouts();
  drawHistory();
  if (message) setStatus(message);
}

function frame() {
  if (!state.running) return;
  const more = optimiser();
  syncSliders();
  paint();
  updateReadouts();
  drawHistory();
  if (!more) {
    stopRun(finishedMessage());
    return;
  }
  requestAnimationFrame(frame);
}

function startRun() {
  if (state.running) return;
  state.running = true;
  state.iteration = 0;
  state.history = [];
  optimiser = makeOptimiser();
  el('xvr-register').disabled = true;
  el('xvr-stop').disabled = false;
  setStatus('Optimising the pose by gradient descent on one minus the normalised cross-correlation.');
  if (reduceMotion) {
    while (optimiser()) { /* run the whole schedule, then show the result */ }
    stopRun(finishedMessage());
    return;
  }
  requestAnimationFrame(frame);
}

function measureCurrent() {
  const size = SCALES[0].size;
  const small = renderer.buffer('probe', size, size);
  renderer.renderInto(small, state.pose, 256);
  const raw = renderer.readback(small);
  const buf = new Float32Array(size * size);
  for (let i = 0; i < buf.length; i++) buf[i] = raw[i * 4];
  state.ncc = ncc(buf, fixedSmall.get(size));
}

function refresh(message) {
  state.iteration = 0;
  state.elapsed = 0;
  state.history = [];
  measureCurrent();
  syncSliders();
  paint();
  updateReadouts();
  drawHistory();
  setStatus(message);
}

function newCase() {
  state.truth = randomTruth();
  state.pose = perturbed(state.truth);
  el('xvr-truth').textContent = 'hidden';
  renderFixed();
  refresh('A radiograph was simulated at an unknown pose. Press Register, or move the sliders yourself.');
}

function wireUI() {
  PARAMS.forEach((p, i) => {
    el(`xvr-${p.key}`).addEventListener('input', (event) => {
      if (state.running) return;
      state.pose[i] = Number(event.target.value);
      el(`xvr-${p.key}-out`).textContent = state.pose[i].toFixed(1) + p.unit;
      measureCurrent();
      paint();
      updateReadouts();
    });
  });

  el('xvr-register').addEventListener('click', startRun);
  el('xvr-stop').addEventListener('click', () => stopRun('Stopped.'));
  el('xvr-new').addEventListener('click', () => {
    if (state.running) stopRun(null);
    newCase();
  });
  el('xvr-perturb').addEventListener('click', () => {
    if (state.running) stopRun(null);
    state.pose = perturbed(state.truth);
    refresh('Pose perturbed. Press Register to recover it.');
  });
  el('xvr-reveal').addEventListener('click', () => {
    el('xvr-truth').textContent = state.truth
      .map((v, i) => v.toFixed(1) + (i < 3 ? '°' : ' mm'))
      .join(', ');
  });
  window.addEventListener('resize', drawHistory);
}

async function init() {
  const canvas = document.createElement('canvas');
  const small = window.innerWidth < 700;
  displaySize = small ? 224 : 320;
  displaySteps = small ? 256 : 384;
  canvas.width = displaySize;
  canvas.height = displaySize;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) {
    setStatus('This demo needs WebGL2, which this browser did not provide.');
    return;
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    setStatus('This demo needs floating point render targets (EXT_color_buffer_float).');
    return;
  }

  setStatus('Loading the CT volume (3 MB)…');
  const [metaRes, volRes] = await Promise.all([fetch(META_URL), fetch(VOL_URL)]);
  if (!metaRes.ok || !volRes.ok) throw new Error('the CT volume could not be downloaded');
  const meta = await metaRes.json();
  const data = new Uint8Array(await volRes.arrayBuffer());

  renderer = new Renderer(gl, meta, data);
  panels = {
    fixed: el('xvr-canvas-fixed'),
    moving: el('xvr-canvas-moving'),
    overlay: el('xvr-canvas-overlay'),
  };
  for (const key of ['fixed', 'moving', 'overlay']) {
    panels[key].width = displaySize;
    panels[key].height = displaySize;
  }

  wireUI();
  newCase();
}

init().catch((err) => {
  setStatus('The demo failed to start: ' + err.message);
  console.error(err);
});
