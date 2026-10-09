/* Viewer for the beating heart reconstructed from a gated cardiac CT.
 *
 * The GLB carries one mesh per structure, each with 20 morph targets holding the vertex
 * offsets of phases 1 to 20 relative to phase 0, and one animation that drives the morph
 * weights. Playing that clip is the whole animation; the slider seeks it.
 *
 * Everything is in CT physical millimetres, including the three CT slice planes, so the model
 * sits inside its own scan rather than floating in the void.
 */
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Clock,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type Plane = {
  name: string;
  axis: number;
  index: number;
  file: string;
  corners: [number, number, number][];
};

type Structure = {
  name: string;
  colour: string;
  points: number;
  faces: number;
  volumePerPhase: number[];
  measuredWatertight: boolean;
};

type Manifest = {
  phases: number;
  fps: number;
  referencePhase: number;
  units: string;
  ct: { planes: Plane[]; window: { level: number; width: number } };
  structures: Structure[];
};

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = el<HTMLCanvasElement>('stage');
const status = el<HTMLParagraphElement>('status');
const toggles = el<HTMLDivElement>('toggles');
const planeToggles = el<HTMLDivElement>('plane-toggles');
const phaseInput = el<HTMLInputElement>('phase');
const phaseLabel = el<HTMLSpanElement>('phase-label');
const playButton = el<HTMLButtonElement>('play');
const volumeOut = document.getElementById('volume-now');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new Scene();
const camera = new PerspectiveCamera(42, 1, 1, 5000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;

scene.add(new AmbientLight(0xffffff, 1.4));
const key = new DirectionalLight(0xffffff, 2.1);
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
let heartVolumes: number[] = [];

function resize(): void {
  const { clientWidth, clientHeight } = canvas;
  if (!clientWidth || !clientHeight) return;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}

function frameOn(target: Box3): void {
  const size = target.getSize(new Vector3());
  const centre = target.getCenter(new Vector3());
  const radius = Math.max(size.x, size.y, size.z);
  controls.target.copy(centre);
  camera.position.copy(centre).add(new Vector3(radius * 1.9, radius * 0.75, radius * 2.1));
  camera.near = radius / 100;
  camera.far = radius * 40;
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
  if (volumeOut && heartVolumes[phase] !== undefined) {
    volumeOut.textContent = `${heartVolumes[phase].toFixed(0)} mL`;
  }
}

function toggleRow(
  label: string,
  colour: string | null,
  note: string,
  onChange: (on: boolean) => void,
): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = true;
  input.addEventListener('change', () => onChange(input.checked));
  const swatch = document.createElement('span');
  swatch.className = colour ? 'swatch' : 'swatch swatch--slice';
  if (colour) swatch.style.background = colour;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = note;
  row.append(input, swatch, name, count);
  return row;
}

/* The CT planes are two triangles each, placed on the corners the exporter measured through
   ITK's index-to-physical transform. Corner order is (0,0), (max,0), (max,max), (0,max) in
   index space; three.js flips textures vertically, hence the v coordinates below. */
function addPlanes(planes: Plane[]): void {
  const group = new Group();
  const loader = new TextureLoader();

  for (const plane of planes) {
    const positions = new Float32Array(plane.corners.flat());
    const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(uv, 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();

    const texture = loader.load(plane.file);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(geometry, new MeshBasicMaterial({
      map: texture,
      side: DoubleSide,
      transparent: true,
      opacity: 0.92,
    }));
    mesh.name = plane.name;
    group.add(mesh);

    planeToggles.append(toggleRow(
      `${plane.name[0].toUpperCase()}${plane.name.slice(1)} slice`,
      null,
      `index ${plane.index}`,
      (on) => { mesh.visible = on; },
    ));
  }
  scene.add(group);
}

async function main(): Promise<void> {
  const manifest: Manifest = await (await fetch('heart.json')).json();
  phaseCount = manifest.phases;
  fps = manifest.fps;
  heartVolumes = manifest.structures.find((s) => s.name === 'Heart')?.volumePerPhase ?? [];

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
    const isWall = key === 'Heart';
    const material = mesh.material as MeshStandardMaterial;
    // The wall encloses the vessels, so it is a shell you can see into, solid enough to read
    // as muscle.
    material.transparent = isWall;
    material.opacity = isWall ? 0.62 : 1;
    material.depthWrite = !isWall;
    meshes.set(key, mesh);
  });

  // Frame on the anatomy, not on the planes, which span the whole chest.
  const anatomy = new Box3().setFromObject(gltf.scene);

  for (const structure of manifest.structures) {
    const mesh = meshes.get(structure.name);
    if (!mesh) continue;
    toggles.append(toggleRow(
      structure.name,
      structure.colour,
      `${structure.faces.toLocaleString('en')} faces`,
      (on) => { mesh.visible = on; },
    ));
  }

  addPlanes(manifest.ct.planes);

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

  frameOn(anatomy);
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
