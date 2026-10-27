import { os } from '../aos';

// Minimise, maximise and close, drawn by the app (the window has no frame of its own). On Windows they sit at the right end of
// the title bar as three flat squares; on a Mac they sit at the left as the usual red, yellow and green dots, closest first.
export default function WindowButtons({ max }: { max: boolean }) {
  const close = <button key="x" className="x" onClick={() => window.aos.window.close()} aria-label="Close window" title="Close"><svg width="11" height="11" viewBox="0 0 11 11"><path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.2" fill="none" /></svg></button>;
  const min = <button key="m" className="min" onClick={() => window.aos.window.minimize()} aria-label="Minimise window" title="Minimise"><svg width="11" height="11" viewBox="0 0 11 11"><path d="M1 5.5h9" stroke="currentColor" strokeWidth="1.2" fill="none" /></svg></button>;
  const big = (
    <button key="z" className="max" onClick={() => window.aos.window.maximize()} aria-label={max ? 'Restore window' : 'Maximise window'} title={max ? 'Restore' : 'Maximise'}>
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2">{max ? <><rect x="1" y="3" width="7" height="7" /><path d="M3 3V1h7v7H8" /></> : <rect x="1.5" y="1.5" width="8" height="8" />}</svg>
    </button>
  );
  return <div className={`win-btns ${os}`} role="group" aria-label="Window">{os === 'mac' ? [close, min, big] : [min, big, close]}</div>;
}
