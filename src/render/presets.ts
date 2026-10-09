import { DEFAULT_SETTINGS, PostSettings } from './settings';

const base = DEFAULT_SETTINGS;

/** a few starting points, each a complete settings object */
export const PRESETS: Record<string, PostSettings> = {
  'Polar hue': base,
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
