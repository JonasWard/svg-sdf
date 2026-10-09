import { DEFAULT_SETTINGS, PostSettings, RampStop } from './settings';

const base = DEFAULT_SETTINGS;

/** a few starting points, each a complete settings object */
export const PRESETS: Record<string, PostSettings> = {
  'Polar hue': base,
  'Polar perceptual': {
    ...base,
    polar: {
      ...base.polar,
      palette: 'oklch',
      inside: { satNear: 0.9, satFar: 0.6, valNear: 0.42, valFar: 0.55 },
      outside: { satNear: 1, satFar: 0.35, valNear: 0.72, valFar: 0.95 }
    }
  },
  'Polar twilight': {
    ...base,
    polar: {
      ...base.polar,
      palette: 'gradient',
      inside: { satNear: 1, satFar: 0.8, valNear: 0.55, valFar: 0.7 },
      outside: { satNear: 1, satFar: 0.3, valNear: 1, valFar: 1 }
    },
    contours: { ...base.contours, opacity: 0.6 }
  },
  'Polar checker': {
    ...base,
    polar: {
      ...base.polar,
      repetitions: 2,
      tiles: { enabled: true, style: 'checker', angleBands: 24, distanceSpacing: 3, contrast: 0.3 }
    },
    contours: { ...base.contours, enabled: false }
  },
  'Polar mosaic': {
    ...base,
    polar: {
      ...base.polar,
      palette: 'oklch',
      inside: { satNear: 0.9, satFar: 0.6, valNear: 0.42, valFar: 0.55 },
      outside: { satNear: 1, satFar: 0.35, valNear: 0.72, valFar: 0.95 },
      tiles: { enabled: true, style: 'mosaic', angleBands: 16, distanceSpacing: 4, contrast: 0.3 }
    },
    contours: { ...base.contours, enabled: false }
  },
  'Polar radial': {
    ...base,
    polar: { ...base.polar, repetitions: 2, radialLines: 48, radialWidth: 1 },
    contours: { ...base.contours, spacing: 3, width: 1 }
  },
  Topography: {
    ...base,
    mode: 'ramp',
    contours: { ...base.contours, spacing: 0.6, width: 1, color: '#ffffff', opacity: 0.55 },
    outline: { enabled: true, width: 4, color: '#ffffff' }
  },
  'Red / blue': {
    ...base,
    mode: 'ramp',
    background: '#ffffff',
    ramp: {
      inside: [
        { pos: 0, color: '#ffffff' },
        { pos: 1, color: '#c0392b' }
      ],
      outside: [
        { pos: 0, color: '#ffffff' },
        { pos: 1, color: '#1f5fa8' }
      ],
      rangeInside: 12,
      rangeOutside: 30,
      repeat: false
    },
    contours: { ...base.contours, style: 'bands', spacing: 2, opacity: 0.25, color: '#000000' }
  },
  'Shape colours': {
    ...base,
    mode: 'shape',
    background: '#ffffff',
    contours: { ...base.contours, spacing: 1, width: 1, opacity: 0.8 }
  },
  'Distance (raw)': {
    ...base,
    mode: 'grayscale',
    contours: { ...base.contours, enabled: false }
  }
};

/** starting points for the cyclic polar gradient, positions wrap around from 1 back to 0 */
export const CYCLIC_GRADIENTS: Record<string, RampStop[]> = {
  Twilight: DEFAULT_SETTINGS.polar.stops,
  'Two-tone': [
    { pos: 0, color: '#1f5fa8' },
    { pos: 0.5, color: '#f2c14e' }
  ],
  Sinebow: ['#ff4040', '#ffd23f', '#40e070', '#30d0ff', '#4060ff', '#e040ff'].map((color, i) => ({
    pos: i / 6,
    color
  })),
  'Ink & paper': [
    { pos: 0, color: '#f4f1ea' },
    { pos: 0.45, color: '#f4f1ea' },
    { pos: 0.5, color: '#1d1d1f' },
    { pos: 0.95, color: '#1d1d1f' }
  ]
};
