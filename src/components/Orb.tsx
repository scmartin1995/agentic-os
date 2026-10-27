import type { OrbState } from '../types';
import Icon from '../icons';

const LABEL: Record<OrbState, string> = { idle: 'Ready', listening: 'Listening', thinking: 'Thinking it over', talking: 'Talking', replying: 'Replying' };

// The assistant's face: one circle whose colour and (when active) pulse say what it is doing. Its state comes only
// from events, never from buttons. Built from plain elements and CSS: no images, no canvas, no per-frame script, and
// nothing moves while it is idle (see .orb in shell.css).
export default function Orb({ state, sub, voice, wake }: {
  state: OrbState; sub: string;
  voice: { muted: boolean; toggle(): void } | null;
  wake: { on: boolean; loading: boolean; toggle(): void } | null;
  level?: () => { level: number; bins: Uint8Array | null }; // kept for callers; the orb does not draw sound levels
  small?: boolean;
}) {
  return (
    <section className="orb" data-state={state} aria-label={`Agentic OS, ${LABEL[state].toLowerCase()}`}>
      <div className="orb-core" aria-hidden><i className="orb-ring" /></div>
      <div className="orb-text">
        <div className="name">Agentic OS</div>
        <div className="st">{LABEL[state]}</div>
        <div className="sub">{sub}</div>
      </div>
      <div className="corner">
        {wake && (
          <button className={`icon-btn${wake.on ? ' on' : ''}`} onClick={wake.toggle} aria-pressed={wake.on}
            aria-label={wake.on ? 'Turn off "Hey computer"' : 'Turn on "Hey computer"'} title={wake.loading ? 'Warming up…' : wake.on ? 'Listening for "Hey computer"' : '"Hey computer" is off'}>
            <Icon name="ear" />
          </button>
        )}
        {voice && (
          <button className={`icon-btn${voice.muted ? '' : ' on'}`} onClick={voice.toggle} aria-pressed={voice.muted} aria-label={voice.muted ? 'Unmute Agentic OS' : 'Mute Agentic OS'} title={voice.muted ? 'Agentic OS is muted' : 'Agentic OS speaks its answers'}>
            <Icon name={voice.muted ? 'mute' : 'sound'} />
          </button>
        )}
      </div>
    </section>
  );
}
