import { useState } from 'react';
import type { Settings } from '../../shared/types';
import { api, errorMessage } from '../lib/api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { toast } from '../lib/toast';
import { Icon } from './Icon';

type DialKey = 'feedReplies' | 'feedReposts' | 'hideCounts';

const CONTROLS: { key: DialKey; label: string; hint: string }[] = [
  { key: 'feedReplies', label: 'Show replies', hint: 'Replies from people you follow to people you follow.' },
  { key: 'feedReposts', label: 'Show reposts', hint: 'Posts shared by people you follow.' },
  { key: 'hideCounts', label: 'Hide counts', hint: 'No like, repost or reply numbers anywhere.' },
];

/**
 * "The Dial": the reader's own feed controls. Changes save to the account immediately (optimistic, with rollback)
 * and Home reloads itself because its list key includes these settings.
 */
export function Dial({ compact }: { compact?: boolean }) {
  const { me, setMe } = useSession();
  const [busy, setBusy] = useState<DialKey | null>(null);
  if (!me) return null;

  async function change(key: DialKey, value: boolean) {
    if (!me) return;
    const prev = me;
    setMe({ ...me, settings: { ...me.settings, [key]: value } });
    setBusy(key);
    try {
      const settings = await api.patch<Settings>('/me/settings', { [key]: value });
      setMe({ ...prev, settings });
    } catch (e) {
      setMe(prev);
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  const muted = me.settings.mutedWords.length;
  return (
    <section className={'dial' + (compact ? ' dial-compact' : '')} aria-labelledby={compact ? undefined : 'dial-title'}>
      {!compact && (
        <header className="dial-head">
          <h2 id="dial-title" className="kicker">
            <Icon name="dial" size={14} /> The Dial
          </h2>
          <p className="dial-lede">Your home feed is chronological. You decide what goes in it.</p>
        </header>
      )}
      <div className="dial-controls">
        {CONTROLS.map((c) => (
          <label className="switch dial-switch" key={c.key}>
            <span>
              <span className="dial-label">{c.label}</span>
              <span className="hint dial-hint">{c.hint}</span>
            </span>
            <input
              type="checkbox"
              checked={me.settings[c.key]}
              disabled={busy === c.key}
              onChange={(e) => void change(c.key, e.target.checked)}
            />
          </label>
        ))}
      </div>
      <Link to="/settings/muting" className="dial-link">
        <span>Muted words</span>
        <span className="meta">{muted ? `${muted} active` : 'none'} →</span>
      </Link>
    </section>
  );
}
