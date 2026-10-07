/* Viewer for the beating heart reconstructed from a gated cardiac CT.
 *
 * The GLB carries one mesh per structure, each with 20 morph targets holding the vertex
 * offsets of phases 1 to 20 relative to phase 0, and one animation that drives the morph
 * weights. Playing that clip is the whole animation; the slider seeks it.
 */
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  Clock,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type Manifest = {
  phases: number;
  fps: number;
  structures: { name: string; label: string; colour: string; points: number; faces: number }[];
};

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const toggles = document.getElementById('toggles') as HTMLDivElement;
const phaseInput = document.getElementById('phase') as HTMLInputElement;
const phaseLabel = document.getElementById('phase-label') as HTMLSpanElement;
const playButton = document.getElementById('play') as HTMLButtonElement;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new Scene();
const camera = new PerspectiveCamera(42, 1, 0.01, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;

scene.add(new AmbientLight(0xffffff, 1.5));
const key = new DirectionalLight(0xffffff, 2.2);
key.position.set(1, 1.4, 1.2);
scene.add(key);
const fill = new DirectionalLight(0xffd9c0, 0.8);
fill.position.set(-1.2, -0.4, -0.8);
scene.add(fill);

const clock = new Clock();
let mixer: AnimationMixer | null = null;
let action: AnimationAction | null = null;
let playing = !reducedMotion;
let phaseCount = 21;
let fps = 14;

function resize(): void {
  const { clientWidth, clientHeight } = canvas;
  if (!clientWidth || !clientHeight) return;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}

function frameScene(): void {
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  const radius = Math.max(size.x, size.y, size.z);
  controls.target.copy(centre);
  camera.position.copy(centre).add(new Vector3(radius * 0.95, radius * 0.35, radius * 1.05));
  camera.near = radius / 100;
  camera.far = radius * 20;
  camera.updateProjectionMatrix();
  controls.update();
}

function setPlaying(next: boolean): void {
  playing = next;
  if (action) action.paused = !playing;
  playButton.setAttribute('aria-pressed', String(playing));
  playButton.textContent = playing ? 'Pause' : 'Play';
}

function showPhase(phase: number): void {
  phaseInput.value = String(phase);
  phaseLabel.textContent = `${phase + 1} of ${phaseCount}`;
}

async function main(): Promise<void> {
  const manifest: Manifest = await (await fetch('heart.json')).json();
  phaseCount = manifest.phases;
  fps = manifest.fps;

  const gltf = await new GLTFLoader().loadAsync('heart.glb');
  scene.add(gltf.scene);

  /* Keyed on the structure name carried in glTF extras, not on the node name: three.js
     sanitises node names for its animation bindings, so "Inferior vena cava" arrives as
     "Inferior_vena_cava" and label matching silently drops most of the structures. */
  const meshes = new Map<string, Mesh>();
  gltf.scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const key = (mesh.userData?.structure as string | undefined) ?? mesh.name;
    const isWall = key === 'heart';
    const material = mesh.material as MeshStandardMaterial;
    // The wall encloses the vessels, so it is shown as a shell you can see into, solid
    // enough to read as muscle.
    material.transparent = isWall;
    material.opacity = isWall ? 0.55 : 1;
    material.depthWrite = !isWall;
    meshes.set(key, mesh);
  });

  for (const structure of manifest.structures) {
    const mesh = meshes.get(structure.name);
    if (!mesh) continue;
    const row = document.createElement('label');
    row.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.addEventListener('change', () => { mesh.visible = input.checked; });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = structure.colour;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = structure.label;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${structure.faces.toLocaleString('en')} faces`;
    row.append(input, swatch, name, count);
    toggles.append(row);
  }

  mixer = new AnimationMixer(gltf.scene);
  action = mixer.clipAction(gltf.animations[0]);
  action.play();

  phaseInput.max = String(phaseCount - 1);
  phaseInput.addEventListener('input', () => {
    setPlaying(false);
    const phase = Number(phaseInput.value);
    showPhase(phase);
    mixer?.setTime(phase / fps);
  });

  playButton.addEventListener('click', () => setPlaying(!playing));
  setPlaying(playing);
  showPhase(0);

  frameScene();
  resize();
  if (reducedMotion) {
    status.hidden = false;
    status.textContent = 'Playback is paused because your system asks for reduced motion.';
  }
}

function tick(): void {
  requestAnimationFrame(tick);
  if (mixer && playing) {
    mixer.update(clock.getDelta());
    showPhase(Math.min(phaseCount - 1, Math.floor(mixer.time * fps) % phaseCount));
  } else {
    clock.getDelta();
  }
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', resize);
tick();

main().catch((error: unknown) => {
  status.hidden = false;
  status.textContent = `Could not load the model: ${error instanceof Error ? error.message : String(error)}`;
});
