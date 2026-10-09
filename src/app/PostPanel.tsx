import { PRESETS } from '../render/presets';
import { MODES, PolarSide, PostSettings } from '../render/settings';
import { ColorField, RampEditor, Section, Segmented, Slider, Toggle } from './controls';
import { useStore } from './store';

const MODE_LABELS = { polar: 'Polar', ramp: 'Ramps', shape: 'Shapes', grayscale: 'Raw' } as const;

/** a setter for one nested group of the settings */
const useGroup = <K extends keyof PostSettings>(key: K) => {
  const value = useStore((s) => s.post[key]);
  const updatePost = useStore((s) => s.updatePost);
  const set = (patch: Partial<PostSettings[K]>) =>
    updatePost((p) => ({ ...p, [key]: { ...(p[key] as object), ...patch } }));
  return [value, set] as const;
};

const PolarSideControls = ({
  title,
  side,
  onChange
}: {
  title: string;
  side: PolarSide;
  onChange: (s: PolarSide) => void;
}) => (
  <>
    <h3>{title}</h3>
    <Slider
      label="Saturation near"
      value={side.satNear}
      min={0}
      max={1}
      onChange={(satNear) => onChange({ ...side, satNear })}
    />
    <Slider
      label="Saturation far"
      value={side.satFar}
      min={0}
      max={1}
      onChange={(satFar) => onChange({ ...side, satFar })}
    />
    <Slider
      label="Value near"
      value={side.valNear}
      min={0}
      max={1}
      onChange={(valNear) => onChange({ ...side, valNear })}
    />
    <Slider
      label="Value far"
      value={side.valFar}
      min={0}
      max={1}
      onChange={(valFar) => onChange({ ...side, valFar })}
    />
  </>
);

export const PostPanel = () => {
  const post = useStore((s) => s.post);
  const setPost = useStore((s) => s.setPost);
  const updatePost = useStore((s) => s.updatePost);
  const [ramp, setRamp] = useGroup('ramp');
  const [polar, setPolar] = useGroup('polar');
  const [shape, setShape] = useGroup('shape');
  const [grayscale, setGrayscale] = useGroup('grayscale');
  const [contours, setContours] = useGroup('contours');
  const [outline, setOutline] = useGroup('outline');

  return (
    <>
      <Section
        title="Colouring"
        aside={
          <select value="" onChange={(e) => e.target.value && setPost(PRESETS[e.target.value])} aria-label="presets">
            <option value="">Presets…</option>
            {Object.keys(PRESETS).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        }
      >
        <Segmented
          options={MODES}
          value={post.mode}
          labels={MODE_LABELS}
          onChange={(mode) => updatePost((p) => ({ ...p, mode }))}
        />
        <ColorField
          label="Background"
          value={post.background}
          onChange={(background) => updatePost((p) => ({ ...p, background }))}
        />

        {post.mode === 'polar' && (
          <>
            <p className="hint">
              Hue follows the direction to the nearest edge, saturation and value follow the distance.
            </p>
            <Slider
              label="Hue repetitions"
              value={polar.repetitions}
              min={1}
              max={8}
              step={1}
              onChange={(repetitions) => setPolar({ repetitions })}
            />
            <Slider
              label="Hue offset"
              value={polar.hueOffset}
              min={0}
              max={1}
              onChange={(hueOffset) => setPolar({ hueOffset })}
            />
            <Slider
              label="Falloff %"
              value={polar.range}
              min={1}
              max={100}
              step={0.5}
              onChange={(range) => setPolar({ range })}
            />
            <Slider
              label="Radial lines"
              value={polar.radialLines}
              min={0}
              max={180}
              step={1}
              onChange={(radialLines) => setPolar({ radialLines })}
            />
            {polar.radialLines > 0 && (
              <Slider
                label="Radial width px"
                value={polar.radialWidth}
                min={0.5}
                max={6}
                step={0.1}
                onChange={(radialWidth) => setPolar({ radialWidth })}
              />
            )}
            <PolarSideControls title="Outside" side={polar.outside} onChange={(outside) => setPolar({ outside })} />
            <PolarSideControls title="Inside" side={polar.inside} onChange={(inside) => setPolar({ inside })} />
          </>
        )}

        {post.mode === 'ramp' && (
          <>
            <RampEditor label="Inside" stops={ramp.inside} onChange={(inside) => setRamp({ inside })} />
            <Slider
              label="Inside range %"
              value={ramp.rangeInside}
              min={0.5}
              max={100}
              step={0.5}
              onChange={(rangeInside) => setRamp({ rangeInside })}
            />
            <RampEditor label="Outside" stops={ramp.outside} onChange={(outside) => setRamp({ outside })} />
            <Slider
              label="Outside range %"
              value={ramp.rangeOutside}
              min={0.5}
              max={100}
              step={0.5}
              onChange={(rangeOutside) => setRamp({ rangeOutside })}
            />
            <Toggle label="Repeat ramps" value={ramp.repeat} onChange={(repeat) => setRamp({ repeat })} />
          </>
        )}

        {post.mode === 'shape' && (
          <>
            <p className="hint">Each pixel takes the colour of its svg shape, outside the one with the nearest edge.</p>
            <Slider
              label="Falloff %"
              value={shape.range}
              min={1}
              max={100}
              step={0.5}
              onChange={(range) => setShape({ range })}
            />
            <Slider
              label="Shade inside"
              value={shape.shadeInside}
              min={0}
              max={1}
              onChange={(shadeInside) => setShape({ shadeInside })}
            />
            <Slider
              label="Fade outside"
              value={shape.fadeOutside}
              min={0}
              max={1}
              onChange={(fadeOutside) => setShape({ fadeOutside })}
            />
          </>
        )}

        {post.mode === 'grayscale' && (
          <>
            <p className="hint">The raw field: mid grey on the edge, black inside, white outside.</p>
            <Slider
              label="Range %"
              value={grayscale.range}
              min={0.5}
              max={100}
              step={0.5}
              onChange={(range) => setGrayscale({ range })}
            />
          </>
        )}
      </Section>

      <Section
        title="Contours"
        aside={<Toggle label="" value={contours.enabled} onChange={(enabled) => setContours({ enabled })} />}
      >
        {contours.enabled && (
          <>
            <Segmented
              options={['lines', 'bands'] as const}
              value={contours.style}
              onChange={(style) => setContours({ style })}
            />
            <Slider
              label="Spacing %"
              value={contours.spacing}
              min={0.1}
              max={20}
              step={0.05}
              onChange={(spacing) => setContours({ spacing })}
            />
            <Slider
              label="Offset %"
              value={contours.offset}
              min={0}
              max={20}
              step={0.05}
              onChange={(offset) => setContours({ offset })}
            />
            {contours.style === 'lines' && (
              <Slider
                label="Width px"
                value={contours.width}
                min={0.25}
                max={10}
                step={0.05}
                onChange={(width) => setContours({ width })}
              />
            )}
            <ColorField label="Colour" value={contours.color} onChange={(color) => setContours({ color })} />
            <Slider
              label="Opacity"
              value={contours.opacity}
              min={0}
              max={1}
              onChange={(opacity) => setContours({ opacity })}
            />
            <div className="button-row">
              <Toggle label="Inside" value={contours.inside} onChange={(inside) => setContours({ inside })} />
              <Toggle label="Outside" value={contours.outside} onChange={(outside) => setContours({ outside })} />
            </div>
          </>
        )}
      </Section>

      <Section
        title="Outline"
        aside={<Toggle label="" value={outline.enabled} onChange={(enabled) => setOutline({ enabled })} />}
      >
        {outline.enabled && (
          <>
            <Slider
              label="Width px"
              value={outline.width}
              min={0.5}
              max={20}
              step={0.25}
              onChange={(width) => setOutline({ width })}
            />
            <ColorField label="Colour" value={outline.color} onChange={(color) => setOutline({ color })} />
          </>
        )}
      </Section>
    </>
  );
};
