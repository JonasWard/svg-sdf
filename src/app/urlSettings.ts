import {
  array,
  bool,
  DenseField,
  densing,
  enumeration,
  fixed,
  int,
  object,
  optional,
  schema,
  undensing
} from 'densing';
import { Bounds, MetricKind } from '../lib/types';
import { MODES, POLAR_PALETTES, PostSettings, View } from '../render/settings';
import type { ComputeSettings } from './store';

/**
 * The settings packed into a short url-safe string with densing. Every number has the range and precision of its
 * slider; values outside are clamped and rounded before encoding, so any settings encode.
 */

/** bump when the schema changes, older links then fall back to the defaults */
const VERSION = 1;

/** the view relative to the buffer region, so it fits any screen and any svg size */
export interface RelativeView {
  /** offset of the view centre from the region centre, in units of the region's larger side */
  x: number;
  y: number;
  /** log2 of world units per css px over world units per buffer px */
  zoom: number;
}

export interface UrlSettings {
  compute: ComputeSettings;
  post: PostSettings;
  view: RelativeView | null;
}

/** colours are hex strings in the settings and 24 bit ints in the payload */
const colorFields = new Set<DenseField>();
const color = (name: string) => {
  const field = int(name, 0, 0xffffff);
  colorFields.add(field);
  return field;
};

const unit = (name: string) => fixed(name, 0, 1, 0.01);
const stops = (name: string) => array(name, 1, 16, object('stop', fixed('pos', 0, 1, 0.001), color('color')));
const polarSide = (name: string) => object(name, unit('satNear'), unit('satFar'), unit('valNear'), unit('valFar'));

const METRIC_KINDS: MetricKind[] = ['euclidean', 'manhattan', 'chebyshev', 'lp', 'polygon'];

export const URL_SCHEMA = schema(
  int('version', 0, 7),
  object(
    'compute',
    int('width', 16, 8192),
    int('padding', 0, 100),
    enumeration('curves', ['exact', 'polyline']),
    object(
      'metric',
      enumeration('kind', METRIC_KINDS),
      fixed('p', 1.05, 16, 0.05),
      int('sides', 3, 12),
      int('angle', 0, 180),
      fixed('aspect', 0.25, 4, 0.001)
    ),
    enumeration('backend', ['auto', 'webgpu', 'webgl', 'cpu']),
    fixed('tolerance', 0.01, 100, 0.01)
  ),
  object(
    'post',
    enumeration('mode', MODES),
    color('background'),
    object(
      'ramp',
      stops('inside'),
      stops('outside'),
      fixed('rangeInside', 0.5, 100, 0.5),
      fixed('rangeOutside', 0.5, 100, 0.5),
      bool('repeat')
    ),
    object(
      'polar',
      enumeration('palette', POLAR_PALETTES),
      stops('stops'),
      int('repetitions', 1, 8),
      unit('hueOffset'),
      fixed('range', 1, 100, 0.5),
      polarSide('inside'),
      polarSide('outside'),
      int('radialLines', 0, 180),
      fixed('radialWidth', 0.5, 6, 0.1),
      object(
        'tiles',
        bool('enabled'),
        enumeration('style', ['checker', 'mosaic']),
        int('angleBands', 2, 96),
        fixed('distanceSpacing', 0.2, 20, 0.1),
        unit('contrast')
      )
    ),
    object('shape', fixed('range', 1, 100, 0.5), unit('shadeInside'), unit('fadeOutside')),
    object('grayscale', fixed('range', 0.5, 100, 0.5)),
    object(
      'contours',
      bool('enabled'),
      enumeration('style', ['lines', 'bands']),
      fixed('spacing', 0.1, 20, 0.05),
      fixed('offset', 0, 20, 0.05),
      fixed('width', 0.25, 10, 0.05),
      color('color'),
      unit('opacity'),
      bool('inside'),
      bool('outside')
    ),
    object('outline', bool('enabled'), fixed('width', 0.5, 20, 0.25), color('color'))
  ),
  optional(
    'view',
    object('view', fixed('x', -4, 4, 0.00005), fixed('y', -4, 4, 0.00005), fixed('zoom', -16, 16, 0.01))
  )
);

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const hexToInt = (hex: unknown) => {
  const m = typeof hex === 'string' ? /^#?([0-9a-f]{6})$/i.exec(hex.trim()) : null;
  return m ? parseInt(m[1], 16) : 0;
};
const intToHex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** shapes a value to fit its field: numbers clamped and rounded to the field's precision, colours to ints */
const conform = (field: DenseField, value: unknown): unknown => {
  if (colorFields.has(field)) return hexToInt(value);
  switch (field.type) {
    case 'int': {
      const n = Number(value);
      return Number.isFinite(n) ? clamp(Math.round(n), field.min, field.max) : field.defaultValue;
    }
    case 'fixed': {
      const n = Number(value);
      if (!Number.isFinite(n)) return field.defaultValue;
      const scale = Math.round(1 / field.precision);
      return clamp(Math.round(n * scale) / scale, field.min, field.max);
    }
    case 'bool':
      return Boolean(value);
    case 'enum':
      return field.options.includes(value as string) ? value : field.defaultValue;
    case 'optional':
      return value == null ? null : conform(field.field, value);
    case 'object': {
      const source = (value ?? {}) as Record<string, unknown>;
      return Object.fromEntries(field.fields.map((f) => [f.name, conform(f, source[f.name])]));
    }
    case 'array': {
      const items = (Array.isArray(value) ? value : []).slice(0, field.maxLength);
      while (items.length < field.minLength) items.push(items[items.length - 1] ?? {});
      return items.map((item) => conform(field.items, item));
    }
    default:
      throw new Error(`unsupported field type ${field.type}`);
  }
};

/** the inverse of the colour part of `conform` */
const restore = (field: DenseField, value: unknown): unknown => {
  if (colorFields.has(field)) return intToHex(value as number);
  switch (field.type) {
    case 'optional':
      return value == null ? null : restore(field.field, value);
    case 'object': {
      const source = value as Record<string, unknown>;
      return Object.fromEntries(field.fields.map((f) => [f.name, restore(f, source[f.name])]));
    }
    case 'array':
      return (value as unknown[]).map((item) => restore(field.items, item));
    default:
      return value;
  }
};

const root = object('root', ...URL_SCHEMA.fields);

export const encodeSettings = ({ compute, post, view }: UrlSettings): string =>
  densing(URL_SCHEMA, conform(root, { version: VERSION, compute, post, view }));

/** the settings in a string from `encodeSettings`, null for anything else */
export const decodeSettings = (text: string): UrlSettings | null => {
  try {
    const data = restore(root, undensing(URL_SCHEMA, text)) as UrlSettings & { version: number };
    if (data.version !== VERSION) return null;
    return { compute: data.compute, post: data.post, view: data.view };
  } catch {
    return null;
  }
};

const regionSize = (region: Bounds) => Math.max(region.maxX - region.minX, region.maxY - region.minY);

export const toRelativeView = (view: View, region: Bounds, pixelSize: number): RelativeView => {
  const size = regionSize(region);
  return {
    x: (view.cx - (region.minX + region.maxX) / 2) / size,
    y: (view.cy - (region.minY + region.maxY) / 2) / size,
    zoom: Math.log2(view.scale / pixelSize)
  };
};

export const fromRelativeView = (view: RelativeView, region: Bounds, pixelSize: number): View => {
  const size = regionSize(region);
  return {
    cx: (region.minX + region.maxX) / 2 + view.x * size,
    cy: (region.minY + region.maxY) / 2 + view.y * size,
    scale: pixelSize * 2 ** view.zoom
  };
};
