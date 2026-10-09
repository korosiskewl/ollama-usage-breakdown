import type { ReactNode } from 'react';
import type { UserSummary } from '../../shared/types';
import { Link, profilePath } from '../lib/router';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/** One person in a list: avatar, name, handle and an optional trailing action (e.g. a FollowButton). */
export function UserRow({ user, action, sub }: { user: UserSummary; action?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="user-row">
      <Link to={profilePath(user.handle)} className="user-row-link">
        <Avatar user={user} size={40} />
        <span className="user-row-text">
          <span className="user-row-name">
            <span className="user-row-display">{user.displayName}</span>
            {user.isPrivate && <Icon name="lock" size={13} title="Private account" />}
            {user.role !== 'user' && <span className="tag tag-moss">{user.role === 'admin' ? 'admin' : 'mod'}</span>}
            {user.suspended && <span className="tag tag-amber">suspended</span>}
          </span>
          <span className="user-row-handle meta">@{user.handle}</span>
          {sub && <span className="user-row-sub">{sub}</span>}
        </span>
      </Link>
      {action && <div className="user-row-action">{action}</div>}
    </div>
  );
}
