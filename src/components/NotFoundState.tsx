import type { ReactNode } from 'react';
import { Link } from '../lib/router';

/** Friendly "this isn't here" block used by the 404 page and by pages whose resource is missing. */
export function NotFoundState({
  title = 'This page isn’t here.',
  children,
  code = '404',
  heading = 'h2',
}: {
  title?: string;
  children?: ReactNode;
  code?: string;
  /** Use h1 when the page has no other heading. */
  heading?: 'h1' | 'h2';
}) {
  const H = heading;
  return (
    <div className="nf">
      <p className="nf-code" aria-hidden="true">
        {code}
      </p>
      <H className="nf-title">{title}</H>
      <div className="nf-body">
        {children ?? <p>The link may be mistyped, or what it pointed to has been deleted. Nothing you did broke anything.</p>}
      </div>
      <div className="nf-actions">
        <Link to="/" className="btn btn-primary">
          Go home
        </Link>
        <Link to="/explore" className="btn">
          Browse Explore
        </Link>
      </div>
    </div>
  );
}
