import { Settings } from './Settings.tsx';
import type { Connection, LiveProvider } from './Settings.tsx';
import type { ConsentState } from '../../lib/consent.ts';
interface Props { onBack: () => void; onConnection: (connection: Connection) => void; consent: ConsentState; onConsent: (consent: ConsentState) => void; provider: LiveProvider; onProvider: (provider: LiveProvider) => void; liveEnabled: boolean }
/** Mounted only after explicit Setup navigation; no automatic report, cloud or inference request. */
export function Setup({ onBack, ...settings }: Props) {
  return <section className="setup-panel" aria-labelledby="setup-heading"><span className="eyebrow">Optional / connected mode</span><h2 id="setup-heading">Account and data choices</h2><p>Local review needs no account. The live backend source is unprovisioned and unverified until activation. Public configuration may be absent; server credentials never belong in VITE variables.</p><Settings {...settings} /><button className="primary" onClick={onBack}>Back to review</button></section>;
}
