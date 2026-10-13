import { describe, expect, it } from 'vitest';
import { PRESETS } from '../render/presets';
import { DEFAULT_SETTINGS } from '../render/settings';
import { DEFAULT_COMPUTE } from './store';
import { decodeSettings, encodeSettings, fromRelativeView, toRelativeView } from './urlSettings';
import { toUrlSettings } from './renderSettings';

const defaults = { compute: DEFAULT_COMPUTE, post: DEFAULT_SETTINGS, view: null };

describe('url settings', () => {
  it('round-trips the defaults in a short string', () => {
    const text = encodeSettings(defaults);
    expect(text).toMatch(/^[\w-]+$/);
    expect(text.length).toBeLessThan(120);
    expect(decodeSettings(text)).toEqual(defaults);
  });

  it('round-trips every preset', () => {
    for (const post of Object.values(PRESETS)) {
      const settings = { ...defaults, post };
      expect(decodeSettings(encodeSettings(settings))).toEqual(settings);
    }
  });

  it('round-trips compute settings and a view', () => {
    const settings = {
      ...defaults,
      compute: {
        ...DEFAULT_COMPUTE,
        width: 3000,
        curves: 'polyline' as const,
        backend: 'cpu' as const,
        tolerance: 2.5,
        metric: { kind: 'polygon' as const, p: 4.5, sides: 7, angle: 30, aspect: 1.5 }
      },
      view: { x: 0.125, y: -0.5, zoom: -1.25 }
    };
    expect(decodeSettings(encodeSettings(settings))).toEqual(settings);
  });

  it('clamps and rounds values that do not fit the schema', () => {
    const decoded = decodeSettings(
      encodeSettings({
        ...defaults,
        compute: { ...DEFAULT_COMPUTE, width: 100000, padding: 12.4 },
        post: {
          ...DEFAULT_SETTINGS,
          background: 'red',
          contours: { ...DEFAULT_SETTINGS.contours, opacity: 0.30000004 }
        }
      })
    )!;
    expect(decoded.compute.width).toBe(8192);
    expect(decoded.compute.padding).toBe(12);
    expect(decoded.post.background).toBe('#000000');
    expect(decoded.post.contours.opacity).toBe(0.3);
  });

  it('rejects strings it did not write', () => {
    const text = encodeSettings(defaults);
    expect(decodeSettings('')).toBeNull();
    expect(decodeSettings('not a payload!')).toBeNull();
    expect(decodeSettings(text.slice(0, 10))).toBeNull();
  });
});

describe('relative view', () => {
  it('inverts', () => {
    const region = { minX: -10, minY: 20, maxX: 90, maxY: 70 };
    const view = { cx: 12, cy: 33, scale: 0.4 };
    const back = fromRelativeView(toRelativeView(view, region, 0.1), region, 0.1);
    expect(back.cx).toBeCloseTo(view.cx);
    expect(back.cy).toBeCloseTo(view.cy);
    expect(back.scale).toBeCloseTo(view.scale);
  });
});

describe('render settings', () => {
  it('turns a preset with overrides into settings that survive the url', () => {
    const settings = toUrlSettings({
      width: 2048,
      padding: 0.12,
      preset: 'Polar twilight',
      post: { polar: { repetitions: 6 }, contours: { spacing: 1.5 } },
      metric: { kind: 'polygon', sides: 3, angle: 0 }
    });
    expect(settings.compute.padding).toBe(12);
    expect(settings.post.polar.repetitions).toBe(6);
    expect(settings.post.polar.palette).toBe(PRESETS['Polar twilight'].polar.palette);
    expect(decodeSettings(encodeSettings(settings))).toEqual(settings);
  });

  it('gives crops the default padding', () => {
    const settings = toUrlSettings({ width: 1600, region: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });
    expect(settings.compute.padding).toBe(DEFAULT_COMPUTE.padding);
  });
});
