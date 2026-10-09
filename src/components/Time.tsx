import { fullTime, shortTime } from '../lib/format';

export function Time({ iso, className = 'meta' }: { iso: string; className?: string }) {
  return (
    <time className={className} dateTime={iso} title={fullTime(iso)}>
      {shortTime(iso)}
    </time>
  );
}
