import { MetricKind, SDF_CHANNELS, SDF_STRIDE, SdfBuffer, toMetricSpec } from '../types';

const MAGIC = 0x46445353; // 'SSDF' little endian
const VERSION = 1;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

interface Header {
  width: number;
  height: number;
  region: SdfBuffer['region'];
  pixelSize: number;
  /** a spec; a bare kind in files from before metric shapes, absent before metrics, those are euclidean */
  metric?: SdfBuffer['metric'] | MetricKind;
  channels: readonly string[];
  colors: SdfBuffer['colors'];
}

/**
 * Binary layout, little endian:
 * u32 magic 'SSDF', u32 version, u32 header byte length, utf-8 json header padded with spaces to a multiple of 4,
 * then width * height * 4 float32 (distance, dx, dy, shape) row major from the top left.
 */
export const encodeSdf = (sdf: SdfBuffer): ArrayBuffer => {
  const header: Header = {
    width: sdf.width,
    height: sdf.height,
    region: sdf.region,
    pixelSize: sdf.pixelSize,
    metric: sdf.metric,
    channels: SDF_CHANNELS,
    colors: sdf.colors
  };
  let json = JSON.stringify(header);
  while ((12 + new TextEncoder().encode(json).length) % 4) json += ' ';
  const headerBytes = new TextEncoder().encode(json);
  const out = new ArrayBuffer(12 + headerBytes.length + sdf.data.byteLength);
  const view = new DataView(out);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, headerBytes.length, true);
  new Uint8Array(out, 12, headerBytes.length).set(headerBytes);
  if (LITTLE_ENDIAN) new Float32Array(out, 12 + headerBytes.length).set(sdf.data);
  else {
    const floats = new DataView(out, 12 + headerBytes.length);
    for (let i = 0; i < sdf.data.length; i++) floats.setFloat32(i * 4, sdf.data[i], true);
  }
  return out;
};

export const decodeSdf = (buffer: ArrayBuffer): SdfBuffer => {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== MAGIC) throw new Error('not an .sdf file');
  if (view.getUint32(4, true) !== VERSION) throw new Error('unsupported .sdf version');
  const length = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, length))) as Header;
  const count = header.width * header.height * SDF_STRIDE;
  if (buffer.byteLength < 12 + length + count * 4) throw new Error('.sdf file is truncated');
  let data: Float32Array;
  if (LITTLE_ENDIAN) data = new Float32Array(buffer.slice(12 + length, 12 + length + count * 4));
  else {
    const floats = new DataView(buffer, 12 + length);
    data = new Float32Array(count);
    for (let i = 0; i < count; i++) data[i] = floats.getFloat32(i * 4, true);
  }
  return {
    width: header.width,
    height: header.height,
    region: header.region,
    pixelSize: header.pixelSize,
    metric: toMetricSpec(header.metric),
    colors: header.colors,
    data
  };
};
