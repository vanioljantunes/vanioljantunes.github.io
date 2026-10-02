/* Build a heart twin, in the browser.
 *
 * Renders the heart surface that monai-physio produced offline from a gated 4D
 * cardiac CT, and lets the reader drive it two ways: scrub the cardiac cycle
 * (per-phase vertex deltas measured by registration) or move the PCA shape
 * modes of the KCL cohort. Nothing is computed here but the displacement and
 * the drawing; every number the page reports was measured during the offline
 * run and travels in manifest.json.
 *
 * Geometry arrives quantised as Int16 to keep the payload small. Lighting uses
 * screen-space derivatives rather than vertex normals, so a deformed shape
 * needs no normal recomputation per frame.
 */

const BASE = '/imaging/twin/data/';

const VERT = `#version 300 es
precision highp float;
in vec3 a_base;
in vec3 a_delta;
uniform mat4 u_mvp;
uniform mat4 u_mv;
out vec3 v_eye;
void main() {
  vec4 eye = u_mv * vec4(a_base + a_delta, 1.0);
  v_eye = eye.xyz;
  gl_Position = u_mvp * vec4(a_base + a_delta, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 v_eye;
uniform vec3 u_colour;
out vec4 outColour;
void main() {
  // Flat shading from the derivative of the eye-space position: no normals to
  // recompute when the sliders move the surface.
  vec3 n = normalize(cross(dFdx(v_eye), dFdy(v_eye)));
  vec3 lightDir = normalize(vec3(0.35, 0.55, 0.75));
  float diffuse = max(dot(n, lightDir), 0.0);
  float rim = pow(1.0 - max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 2.5);
  vec3 lit = u_colour * (0.28 + 0.72 * diffuse) + vec3(0.18) * rim;
  outColour = vec4(lit, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader failed to compile');
  }
  return shader;
}

function link(gl, vertSource, fragSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'program failed to link');
  }
  return program;
}

/* Matrix helpers, column-major, enough for one perspective camera. */

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[0 * 4 + j] * b[i * 4 + 0] +
        a[1 * 4 + j] * b[i * 4 + 1] +
        a[2 * 4 + j] * b[i * 4 + 2] +
        a[3 * 4 + j] * b[i * 4 + 3];
    }
  }
  return out;
}

function orbitView(yaw, pitch, distance, centre) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const m = new Float32Array(16);
  m[0] = cy; m[4] = 0; m[8] = -sy; m[12] = 0;
  m[1] = sp * sy; m[5] = cp; m[9] = sp * cy; m[13] = 0;
  m[2] = cp * sy; m[6] = -sp; m[10] = cp * cy; m[14] = -distance;
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  const t = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -centre[0], -centre[1], -centre[2], 1,
  ]);
  return multiply(m, t);
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.arrayBuffer();
}

function dequantise(packed, scale, offset) {
  const out = new Float32Array(packed.length);
  for (let i = 0; i < packed.length; i += 3) {
    out[i] = packed[i] * scale + offset[0];
    out[i + 1] = packed[i + 1] * scale + offset[1];
    out[i + 2] = packed[i + 2] * scale + offset[2];
  }
  return out;
}

class HeartView {
  constructor(canvas) {
    this.canvas = canvas;
    this.yaw = 0.6;
    this.pitch = 0.25;
    this.phase = 0;
    this.modeWeights = [];
    this.playing = false;
    this.indexCount = 0;

    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 is unavailable in this browser');
    this.gl = gl;
    this.program = link(gl, VERT, FRAG);
    gl.enable(gl.DEPTH_TEST);

    this.vao = gl.createVertexArray();
    this.baseBuffer = gl.createBuffer();
    this.deltaBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();

    this.attachPointerControls();
  }

  attachPointerControls() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const down = (event) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
    };
    const move = (event) => {
      if (!dragging) return;
      this.yaw += (event.clientX - lastX) * 0.01;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (event.clientY - lastY) * 0.01));
      lastX = event.clientX;
      lastY = event.clientY;
      this.draw();
    };
    const up = (event) => {
      dragging = false;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    };
    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);

    // Keyboard orbit, so the view is reachable without a pointer.
    this.canvas.addEventListener('keydown', (event) => {
      const step = 0.12;
      if (event.key === 'ArrowLeft') this.yaw -= step;
      else if (event.key === 'ArrowRight') this.yaw += step;
      else if (event.key === 'ArrowUp') this.pitch = Math.max(-1.4, this.pitch - step);
      else if (event.key === 'ArrowDown') this.pitch = Math.min(1.4, this.pitch + step);
      else return;
      event.preventDefault();
      this.draw();
    });
  }

  setGeometry(positions, indices, phaseDeltas, modes) {
    const gl = this.gl;
    this.indexCount = indices.length;
    this.positions = positions;
    this.phaseDeltas = phaseDeltas;
    this.modes = modes;
    this.displacement = new Float32Array(positions.length);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
    this.centre = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2);
    this.radius = Math.max(...[0, 1, 2].map((axis) => max[axis] - min[axis])) || 1;

    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.baseBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const baseLoc = gl.getAttribLocation(this.program, 'a_base');
    gl.enableVertexAttribArray(baseLoc);
    gl.vertexAttribPointer(baseLoc, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.deltaBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.displacement, gl.DYNAMIC_DRAW);
    const deltaLoc = gl.getAttribLocation(this.program, 'a_delta');
    gl.enableVertexAttribArray(deltaLoc);
    gl.vertexAttribPointer(deltaLoc, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    this.updateDisplacement();
  }

  /* Phase deltas and mode weights move the same vertex array; they are summed
   * rather than switched, so a mode can be inspected mid-beat. */
  updateDisplacement() {
    const out = this.displacement;
    if (!out) return;
    out.fill(0);

    if (this.phaseDeltas && this.phaseDeltas.length) {
      const count = this.phaseDeltas.length;
      const position = ((this.phase % count) + count) % count;
      const lower = Math.floor(position);
      const upper = (lower + 1) % count;
      const blend = position - lower;
      const a = this.phaseDeltas[lower];
      const b = this.phaseDeltas[upper];
      for (let i = 0; i < out.length; i++) {
        out[i] += a[i] * (1 - blend) + b[i] * blend;
      }
    }

    if (this.modes) {
      for (let m = 0; m < this.modes.length; m++) {
        const weight = this.modeWeights[m] || 0;
        if (weight === 0) continue;
        const mode = this.modes[m];
        for (let i = 0; i < out.length; i++) out[i] += mode[i] * weight;
      }
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.deltaBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, out);
    this.draw();
  }

  resize() {
    const canvas = this.canvas;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  draw() {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.07, 0.07, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.indexCount) return;

    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const projection = perspective(Math.PI / 4, aspect, this.radius * 0.05, this.radius * 12);
    const view = orbitView(this.yaw, this.pitch, this.radius * 2.4, this.centre);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'u_mv'), false, view);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'u_mvp'), false, multiply(projection, view));
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_colour'), 0.78, 0.33, 0.26);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}

async function loadGeometry(manifest) {
  const { motion, modes } = manifest;
  const motionBuffer = await fetchBuffer(BASE + motion.file);

  const vertexCount = motion.vertices;
  const triangleCount = motion.triangles;
  let cursor = 0;

  const basePacked = new Int16Array(motionBuffer, cursor, vertexCount * 3);
  cursor += basePacked.byteLength;
  const indices = new Uint32Array(motionBuffer.slice(cursor, cursor + triangleCount * 3 * 4));
  cursor += triangleCount * 3 * 4;

  const positions = dequantise(basePacked, motion.quant.scale, motion.quant.offset);

  const phaseDeltas = [];
  for (let phase = 0; phase < motion.phases; phase++) {
    const packed = new Int16Array(motionBuffer, cursor, vertexCount * 3);
    cursor += packed.byteLength;
    const delta = new Float32Array(packed.length);
    for (let i = 0; i < packed.length; i++) delta[i] = packed[i] * motion.quant.deltaScale;
    phaseDeltas.push(delta);
  }

  let modeVectors = null;
  if (modes && modes.file) {
    const modeBuffer = await fetchBuffer(BASE + modes.file);
    modeVectors = [];
    for (let m = 0; m < modes.count; m++) {
      const packed = new Int16Array(modeBuffer, m * vertexCount * 3 * 2, vertexCount * 3);
      const vector = new Float32Array(packed.length);
      for (let i = 0; i < packed.length; i++) vector[i] = packed[i] * modes.quant.scale;
      modeVectors.push(vector);
    }
  }

  return { positions, indices, phaseDeltas, modeVectors };
}

function wireControls(view, manifest) {
  const scrub = document.getElementById('twin-phase');
  const play = document.getElementById('twin-play');
  const phaseLabel = document.getElementById('twin-phase-label');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const lastPhase = manifest.motion.phases - 1;

  if (scrub) {
    scrub.max = String(lastPhase);
    scrub.addEventListener('input', () => {
      view.phase = Number(scrub.value);
      if (phaseLabel) phaseLabel.textContent = `Phase ${scrub.value} of ${lastPhase}`;
      view.updateDisplacement();
    });
  }

  let frame = 0;
  const tick = () => {
    if (!view.playing) return;
    view.phase = (view.phase + 0.08) % manifest.motion.phases;
    if (scrub) scrub.value = String(Math.round(view.phase));
    view.updateDisplacement();
    frame = requestAnimationFrame(tick);
  };

  if (play) {
    play.addEventListener('click', () => {
      view.playing = !view.playing;
      play.textContent = view.playing ? 'Pause' : 'Play the beat';
      play.setAttribute('aria-pressed', String(view.playing));
      if (view.playing) frame = requestAnimationFrame(tick);
      else cancelAnimationFrame(frame);
    });
    // Reduced motion: the beat never autoplays, and stops if the setting changes.
    reduceMotion.addEventListener('change', () => {
      if (reduceMotion.matches && view.playing) play.click();
    });
  }

  document.querySelectorAll('[data-mode]').forEach((slider) => {
    const index = Number(slider.dataset.mode);
    const readout = document.getElementById(`twin-mode-${index}-value`);
    slider.addEventListener('input', () => {
      const sd = Number(slider.value);
      view.modeWeights[index] = sd;
      if (readout) readout.textContent = `${sd > 0 ? '+' : ''}${sd.toFixed(1)} SD`;
      view.updateDisplacement();
    });
  });

  const reset = document.getElementById('twin-reset');
  if (reset) {
    reset.addEventListener('click', () => {
      view.modeWeights = [];
      document.querySelectorAll('[data-mode]').forEach((slider) => {
        slider.value = '0';
        const index = Number(slider.dataset.mode);
        const readout = document.getElementById(`twin-mode-${index}-value`);
        if (readout) readout.textContent = '0.0 SD';
      });
      view.updateDisplacement();
    });
  }
}

async function main() {
  const canvas = document.getElementById('twin-canvas');
  const status = document.getElementById('twin-status');
  if (!canvas) return;

  try {
    const manifest = await fetchJSON(BASE + 'manifest.json');
    const view = new HeartView(canvas);
    const { positions, indices, phaseDeltas, modeVectors } = await loadGeometry(manifest);
    view.setGeometry(positions, indices, phaseDeltas, modeVectors);
    wireControls(view, manifest);
    window.addEventListener('resize', () => view.draw());
    if (status) {
      status.textContent =
        `${manifest.motion.vertices.toLocaleString()} vertices, ${manifest.motion.phases} phases.`;
    }
  } catch (error) {
    if (status) status.textContent = `The heart could not be loaded: ${error.message}`;
    throw error;
  }
}

main();
