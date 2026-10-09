import { Fragment, type ReactNode } from 'react';
import { Link, profilePath } from '../lib/router';

// Splits text into plain runs, @mentions and http(s) links. React escapes every run, so no HTML is ever injected.
const TOKEN = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])|(^|[^\w@])@([A-Za-z0-9_]{3,20})\b/g;

export function RichText({ text, mentions }: { text: string; mentions?: string[] }) {
  const known = mentions ? new Set(mentions.map((m) => m.toLowerCase())) : null;
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((para, pi) => (
        <p key={pi}>{renderInline(para, known)}</p>
      ))}
    </>
  );
}

function renderInline(text: string, known: Set<string> | null): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (m[1]) {
      out.push(withBreaks(text.slice(last, start), k++));
      const url = m[1];
      let display = url.replace(/^https?:\/\//, '');
      if (display.length > 42) display = display.slice(0, 40) + '…';
      out.push(
        <a key={k++} className="rt-link" href={url} target="_blank" rel="noopener noreferrer nofollow ugc">
          {display}
        </a>,
      );
      last = start + url.length;
    } else {
      const lead = m[2] ?? '';
      const handle = m[3];
      const atStart = start + lead.length;
      if (known && !known.has(handle.toLowerCase())) continue;
      out.push(withBreaks(text.slice(last, atStart), k++));
      out.push(
        <Link key={k++} className="rt-mention" to={profilePath(handle)}>
          @{handle}
        </Link>,
      );
      last = atStart + 1 + handle.length;
    }
  }
  out.push(withBreaks(text.slice(last), k++));
  return out;
}

function withBreaks(s: string, key: number): ReactNode {
  if (!s.includes('\n')) return <Fragment key={key}>{s}</Fragment>;
  const parts = s.split('\n');
  return (
    <Fragment key={key}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {p}
        </Fragment>
      ))}
    </Fragment>
  );
}
