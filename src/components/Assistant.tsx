import { useState } from 'react';
import type { AssistantState } from '../types';
import Icon from '../icons';

const LABEL: Record<AssistantState, string> = { idle: 'Ready', listening: 'Listening', thinking: 'Thinking', talking: 'Talking', replying: 'Replying' };

// The assistant's card at the top of the chat column: an avatar, its name, what it is doing, and the voice switches.
// The avatar is agent/avatar.png in the workspace if there is one; otherwise the first letter of the name.
// Its state comes only from events (App.tsx), never from buttons.
export default function Assistant({ name, state, sub, voice, wake, wakeWord }: {
  name: string; state: AssistantState; sub: string;
  voice: { muted: boolean; toggle(): void } | null;
  wake: { on: boolean; loading: boolean; toggle(): void } | null;
  wakeWord: string;
}) {
  const [art, setArt] = useState(true); // false once agent/avatar.png failed to load
  return (
    <section className="assistant" data-state={state} aria-label={`${name}, ${LABEL[state].toLowerCase()}`}>
      <div className="avatar">
        {art ? <img src="vault://x/agent/avatar.png" alt="" onError={() => setArt(false)} draggable={false} /> : <span>{name.slice(0, 1).toUpperCase()}</span>}
      </div>
      <div className="who-plate">
        <b className="name">{name}</b>
        <span className="st"><i className="dot" />{LABEL[state]}</span>
        <span className="sub">{sub}</span>
      </div>
      <div className="corner">
        {wake && (
          <button className={`icon-btn${wake.on ? ' on' : ''}`} onClick={wake.toggle} aria-pressed={wake.on}
            aria-label={wake.on ? `Turn off "${wakeWord}"` : `Turn on "${wakeWord}"`} title={wake.loading ? 'Warming up…' : wake.on ? `Listening for "${wakeWord}"` : `"${wakeWord}" is off`}>
            <Icon name="ear" />
          </button>
        )}
        {voice && (
          <button className={`icon-btn${voice.muted ? '' : ' on'}`} onClick={voice.toggle} aria-pressed={voice.muted} aria-label={voice.muted ? 'Unmute' : 'Mute'} title={voice.muted ? 'Muted' : 'Answers are spoken'}>
            <Icon name={voice.muted ? 'mute' : 'sound'} />
          </button>
        )}
      </div>
    </section>
  );
}
