import { computeInside, PreparedScene } from '../sdf/compute';
import { SDF_STRIDE, SdfLayout } from '../types';
import { GpuKernel } from './kernel';
import { packScene } from './pack';

/** wall time a tile should take: long enough to keep the gpu busy, short enough to never trip a gpu watchdog */
const TARGET_MS = 40;

/**
 * Computes the whole buffer with a gpu kernel, tile by tile. The inside test runs on the cpu per band of rows and is
 * handed to the kernel with each tile; tile sizes adapt to the measured time per tile.
 */
export const computeOnGpu = async (
  kernel: GpuKernel,
  prepared: PreparedScene,
  layout: SdfLayout,
  onProgress?: (fraction: number) => void,
  cancelled: () => boolean = () => false
): Promise<Float32Array> => {
  kernel.load(packScene(prepared, layout));
  const { width, height } = layout;
  const data = new Float32Array(width * height * SDF_STRIDE);
  let size = Math.min(128, kernel.maxTile);
  let done = 0;
  for (let y = 0; y < height; ) {
    const bandHeight = Math.min(size, height - y);
    const inside = computeInside(prepared, layout, y, y + bandHeight);
    for (let x = 0; x < width; ) {
      const tileWidth = Math.min(size, width - x);
      const tileInside = new Float32Array(tileWidth * bandHeight);
      for (let r = 0; r < bandHeight; r++)
        for (let c = 0; c < tileWidth; c++) tileInside[r * tileWidth + c] = inside[r * width + x + c];
      const start = performance.now();
      const out = await kernel.run({ x, y, width: tileWidth, height: bandHeight }, tileInside);
      const elapsed = performance.now() - start;
      for (let r = 0; r < bandHeight; r++)
        data.set(
          out.subarray(r * tileWidth * SDF_STRIDE, (r + 1) * tileWidth * SDF_STRIDE),
          ((y + r) * width + x) * SDF_STRIDE
        );
      x += tileWidth;
      done += tileWidth * bandHeight;
      onProgress?.(done / (width * height));
      if (cancelled()) throw new Error('cancelled');
      // a tile of twice the side takes about four times as long
      if (elapsed * 4 < TARGET_MS && size < kernel.maxTile) size = Math.min(kernel.maxTile, size * 2);
      else if (elapsed > TARGET_MS * 2 && size > 32) size = Math.max(32, size / 2);
    }
    y += bandHeight;
  }
  return data;
};
