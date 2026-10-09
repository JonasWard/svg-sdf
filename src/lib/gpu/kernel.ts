import { PackedScene } from './pack';

export type GpuBackend = 'webgpu' | 'webgl';

export interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** a gpu implementation of the nearest-edge kernel; one scene is loaded at a time */
export interface GpuKernel {
  readonly backend: GpuBackend;
  /** the largest tile side `run` accepts */
  readonly maxTile: number;
  /** a software renderer (swiftshader, llvmpipe, ...), usually much slower than the cpu workers */
  readonly software: boolean;
  /** the adapter or renderer, for the status line */
  readonly description: string;
  load(scene: PackedScene): void;
  /** the tile's pixels, 4 floats each, row major; `inside` holds the tile's topmost containing shape per pixel */
  run(tile: Tile, inside: Float32Array): Promise<Float32Array>;
  dispose(): void;
}

/** the polygon normals and vertex directions interleaved as vec4s, padded to `count` entries */
export const polygonData = (scene: PackedScene, count: number) => {
  const out = new Float32Array(count * 4);
  for (let k = 0; k < scene.sides; k++) {
    out[k * 4] = scene.normals[k * 2];
    out[k * 4 + 1] = scene.normals[k * 2 + 1];
    out[k * 4 + 2] = scene.vertices[k * 2];
    out[k * 4 + 3] = scene.vertices[k * 2 + 1];
  }
  return out;
};

/** renderer names of software gpus */
export const isSoftwareRenderer = (name: string) =>
  /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i.test(name);

/** p above this overflows float32 in the lp refinement, those metrics stay on the cpu */
export const GPU_MAX_P = 16;

export const checkSupported = (scene: PackedScene) => {
  if (scene.search === 2 && scene.p > GPU_MAX_P) throw new Error(`lp with p above ${GPU_MAX_P} runs on the cpu`);
};
