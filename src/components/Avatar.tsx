import { useEffect, useState } from 'react';
import type { UserSummary } from '../../shared/types';
import { resolveMedia } from '../lib/api';

// Deterministic warm palette for monogram avatars.
const HUES = [12, 28, 42, 95, 150, 190, 215, 265, 320, 350];

function hueFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function Avatar({ user, size = 40 }: { user: Pick<UserSummary, 'id' | 'displayName' | 'avatarUrl'>; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (user.avatarUrl) resolveMedia(user.avatarUrl).then((s) => live && setSrc(s), () => {});
    return () => {
      live = false;
    };
  }, [user.avatarUrl]);

  const initial = (user.displayName || '?').trim().charAt(0).toUpperCase() || '?';
  const hue = hueFor(user.id || user.displayName);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        ['--av-h' as string]: hue,
      }}
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" width={size} height={size} loading="lazy" /> : initial}
    </span>
  );
}
