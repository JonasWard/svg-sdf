/// <reference types="@webgpu/types" />
import shaderSource from './sdf.wgsl?raw';
import { checkSupported, GpuKernel, isSoftwareRenderer, polygonData, Tile } from './kernel';
import { EDGE_FLOATS, MAX_POLYGON_SIDES, NODE_FLOATS, PackedScene } from './pack';

const MAX_TILE = 1024;
const PARAMS_BYTES = 96;

/** the kernel as a webgpu compute shader, dispatched and read back per tile */
export class WebGpuKernel implements GpuKernel {
  readonly backend = 'webgpu' as const;
  readonly maxTile = MAX_TILE;
  private params: GPUBuffer;
  private inside: GPUBuffer;
  private result: GPUBuffer;
  private staging: GPUBuffer;
  private polygon: GPUBuffer;
  private nodes: GPUBuffer | null = null;
  private edges: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private scene: PackedScene | null = null;
  private lost: string | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
    readonly description: string,
    readonly software: boolean
  ) {
    const buffer = (size: number, usage: GPUBufferUsageFlags) => device.createBuffer({ size, usage });
    this.params = buffer(PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.inside = buffer(MAX_TILE * MAX_TILE * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.result = buffer(MAX_TILE * MAX_TILE * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.staging = buffer(MAX_TILE * MAX_TILE * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.polygon = buffer(MAX_POLYGON_SIDES * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.lost.then((info) => (this.lost = info.message || 'device lost'));
  }

  static async create(): Promise<WebGpuKernel> {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
    if (!gpu) throw new Error('WebGPU is not available');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const adapterInfo = (adapter as GPUAdapter & { info?: GPUAdapterInfo & { isFallbackAdapter?: boolean } }).info;
    const description =
      [adapterInfo?.vendor, adapterInfo?.architecture, adapterInfo?.description].filter(Boolean).join(' ') ||
      'WebGPU adapter';
    const software =
      Boolean(adapterInfo?.isFallbackAdapter || (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter) ||
      isSoftwareRenderer(description);
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize }
    });
    const module = device.createShaderModule({ code: shaderSource });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length)
      throw new Error('sdf shader: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
    device.pushErrorScope('validation');
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const error = await device.popErrorScope();
    if (error) throw new Error('sdf pipeline: ' + error.message);
    return new WebGpuKernel(device, pipeline, description, software);
  }

  load(scene: PackedScene) {
    checkSupported(scene);
    this.scene = scene;
    const device = this.device;
    this.nodes?.destroy();
    this.edges?.destroy();
    const storage = (data: Float32Array) => {
      const buffer = device.createBuffer({
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
      return buffer;
    };
    this.nodes = storage(scene.nodes.subarray(0, Math.max(1, scene.nodeCount) * NODE_FLOATS));
    this.edges = storage(scene.edges.subarray(0, Math.max(1, scene.edgeCount) * EDGE_FLOATS));
    device.queue.writeBuffer(this.polygon, 0, polygonData(scene, MAX_POLYGON_SIDES));
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.nodes } },
        { binding: 2, resource: { buffer: this.edges } },
        { binding: 3, resource: { buffer: this.inside } },
        { binding: 4, resource: { buffer: this.polygon } },
        { binding: 5, resource: { buffer: this.result } }
      ]
    });
  }

  /** the uniform block, laid out like the wgsl Params struct */
  private writeParams(scene: PackedScene, tile: Tile) {
    const bytes = new ArrayBuffer(PARAMS_BYTES);
    const f = new Float32Array(bytes);
    const i = new Int32Array(bytes);
    const [m0, m1, m2, m3] = scene.matrix;
    const [n0, n1, n2, n3] = scene.inverse;
    // mat2x2 columns
    f.set([m0, m2, m1, m3], 0);
    f.set([n0, n2, n1, n3], 4);
    i.set(
      [scene.width, scene.height, tile.x, tile.y, tile.width, tile.height, scene.search, scene.sides, scene.edgeCount],
      8
    );
    f.set([scene.scale, scene.pixelSize, scene.p, scene.far], 17);
    this.device.queue.writeBuffer(this.params, 0, bytes);
  }

  async run(tile: Tile, inside: Float32Array): Promise<Float32Array> {
    if (!this.scene || !this.bindGroup) throw new Error('no scene loaded');
    if (this.lost) throw new Error('WebGPU device lost: ' + this.lost);
    const device = this.device;
    this.writeParams(this.scene, tile);
    device.queue.writeBuffer(this.inside, 0, inside as Float32Array<ArrayBuffer>);
    const size = tile.width * tile.height * 16;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(tile.width / 8), Math.ceil(tile.height / 8));
    pass.end();
    encoder.copyBufferToBuffer(this.result, 0, this.staging, 0, size);
    device.pushErrorScope('validation');
    device.queue.submit([encoder.finish()]);
    const error = await device.popErrorScope();
    if (error) throw new Error('WebGPU: ' + error.message);
    await this.staging.mapAsync(GPUMapMode.READ, 0, size);
    const out = new Float32Array(this.staging.getMappedRange(0, size).slice(0));
    this.staging.unmap();
    if (this.lost) throw new Error('WebGPU device lost: ' + this.lost);
    return out;
  }

  dispose() {
    for (const b of [this.params, this.inside, this.result, this.staging, this.polygon, this.nodes, this.edges])
      b?.destroy();
    this.device.destroy();
  }
}
