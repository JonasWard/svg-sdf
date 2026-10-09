import vertexSource from '../../render/shaders/fullscreen.vert.glsl?raw';
import fragmentSource from './sdf.frag.glsl?raw';
import { checkSupported, GpuKernel, isSoftwareRenderer, polygonData, Tile } from './kernel';
import { EDGE_FLOATS, MAX_POLYGON_SIDES, NODE_FLOATS, PackedScene } from './pack';

const MAX_TILE = 1024;
const UNIFORMS = [
  'uNodes',
  'uEdges',
  'uInside',
  'uTexWidth',
  'uSize',
  'uOffset',
  'uSearch',
  'uMatrix',
  'uInverse',
  'uScale',
  'uPixelSize',
  'uP',
  'uSides',
  'uPolygon',
  'uEdgeCount',
  'uFar'
] as const;

const compile = (gl: WebGL2RenderingContext, type: GLenum, source: string) => {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('sdf shader: ' + gl.getShaderInfoLog(shader));
  return shader;
};

/** the kernel as a fragment pass into a float framebuffer, read back per tile */
export class WebGlKernel implements GpuKernel {
  readonly backend = 'webgl' as const;
  readonly maxTile: number;
  readonly software: boolean;
  readonly description: string;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private readonly nodes: WebGLTexture;
  private readonly edges: WebGLTexture;
  private readonly inside: WebGLTexture;
  private readonly target: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly texWidth: number;
  private scene: PackedScene | null = null;

  constructor() {
    const canvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 cannot render to float textures here');
    this.gl = gl;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    this.description = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    this.software = isSoftwareRenderer(this.description);
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error('sdf shader: ' + gl.getProgramInfoLog(program));
    this.program = program;
    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(program, n)])) as WebGlKernel['u'];
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.texWidth = Math.min(4096, maxSize);
    this.maxTile = Math.min(MAX_TILE, maxSize);
    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    this.nodes = texture();
    this.edges = texture();
    this.inside = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.maxTile, this.maxTile, 0, gl.RED, gl.FLOAT, null);
    this.target = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.maxTile, this.maxTile, 0, gl.RGBA, gl.FLOAT, null);
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('float framebuffer incomplete');
    this.vao = gl.createVertexArray()!;
  }

  /** a float array of vec4 texels as a texture `texWidth` wide */
  private upload(texture: WebGLTexture, data: Float32Array) {
    const gl = this.gl;
    const texels = data.length / 4;
    const rows = Math.max(1, Math.ceil(texels / this.texWidth));
    if (rows > (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number))
      throw new Error('scene too large for the WebGL kernel');
    const padded = new Float32Array(rows * this.texWidth * 4);
    padded.set(data);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.texWidth, rows, 0, gl.RGBA, gl.FLOAT, padded);
  }

  load(scene: PackedScene) {
    checkSupported(scene);
    this.scene = scene;
    this.upload(this.nodes, scene.nodes.subarray(0, Math.max(1, scene.nodeCount) * NODE_FLOATS));
    this.upload(this.edges, scene.edges.subarray(0, Math.max(1, scene.edgeCount) * EDGE_FLOATS));
    const gl = this.gl;
    const u = this.u;
    const [m0, m1, m2, m3] = scene.matrix;
    const [i0, i1, i2, i3] = scene.inverse;
    gl.useProgram(this.program);
    gl.uniform1i(u.uNodes, 0);
    gl.uniform1i(u.uEdges, 1);
    gl.uniform1i(u.uInside, 2);
    gl.uniform1i(u.uTexWidth, this.texWidth);
    gl.uniform2i(u.uSize, scene.width, scene.height);
    gl.uniform1i(u.uSearch, scene.search);
    // gl matrices are column major
    gl.uniformMatrix2fv(u.uMatrix, false, [m0, m2, m1, m3]);
    gl.uniformMatrix2fv(u.uInverse, false, [i0, i2, i1, i3]);
    gl.uniform1f(u.uScale, scene.scale);
    gl.uniform1f(u.uPixelSize, scene.pixelSize);
    gl.uniform1f(u.uP, scene.p);
    gl.uniform1i(u.uSides, scene.sides);
    gl.uniform4fv(u.uPolygon, polygonData(scene, MAX_POLYGON_SIDES));
    gl.uniform1i(u.uEdgeCount, scene.edgeCount);
    gl.uniform1f(u.uFar, scene.far);
  }

  async run(tile: Tile, inside: Float32Array): Promise<Float32Array> {
    if (!this.scene) throw new Error('no scene loaded');
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.nodes);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.edges);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.inside);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tile.width, tile.height, gl.RED, gl.FLOAT, inside);
    gl.uniform2i(this.u.uOffset, tile.x, tile.y);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, tile.width, tile.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Float32Array(tile.width * tile.height * 4);
    // rows come back bottom up, which is tile row 0 first: the shader puts local row j at gl_FragCoord.y = j + 0.5
    gl.readPixels(0, 0, tile.width, tile.height, gl.RGBA, gl.FLOAT, out);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error}`);
    if (gl.isContextLost()) throw new Error('WebGL context lost');
    return out;
  }

  dispose() {
    const gl = this.gl;
    for (const t of [this.nodes, this.edges, this.inside, this.target]) gl.deleteTexture(t);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
