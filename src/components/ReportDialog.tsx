import { useId, useState } from 'react';
import type { ReportReason } from '../../shared/types';
import { LIMITS, charCount } from '../../shared/limits';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { Link } from '../lib/router';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export const REPORT_REASONS: { value: ReportReason; label: string; description: string }[] = [
  { value: 'spam', label: 'Spam', description: 'Repetitive, misleading or unsolicited commercial posting.' },
  { value: 'harassment', label: 'Harassment or bullying', description: 'Targeting someone with abuse, intimidation or pile-ons.' },
  { value: 'hate', label: 'Hateful conduct', description: 'Attacking people for who they are — race, religion, gender, sexuality, disability.' },
  { value: 'violence', label: 'Violence or threats', description: 'Threatening, inciting or glorifying violence against anyone.' },
  { value: 'sexual', label: 'Sexual content', description: 'Unsolicited explicit material, or anything sexualising minors.' },
  { value: 'self_harm', label: 'Self-harm', description: 'Encouraging or promoting suicide or self-injury.' },
  { value: 'impersonation', label: 'Impersonation', description: 'Pretending to be another person or organisation to mislead.' },
  { value: 'other', label: 'Something else', description: 'Breaks the community rules in another way — tell us more below.' },
];

export const reasonLabel = (r: ReportReason) => REPORT_REASONS.find((x) => x.value === r)?.label ?? r;

export function ReportDialog({ target, onClose }: { target: { type: 'post' | 'user'; id: string; label: string }; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const uid = useId();
  const formId = `${uid}-form`;
  const detailsId = `${uid}-details`;

  const len = charCount(details);
  const over = len > LIMITS.reportDetails.max;
  const needsDetails = reason === 'other' && !details.trim();

  async function submit() {
    if (!reason || over || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/reports', { targetType: target.type, targetId: target.id, reason, details: details.trim() || undefined });
      setDone(true);
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 429
          ? 'You’ve sent a lot of reports in the last hour. Please wait a while before sending more.'
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Dialog
        title="Report sent"
        onClose={onClose}
        footer={
          <button className="btn btn-primary" onClick={onClose} autoFocus>
            Done
          </button>
        }
      >
        <div className="report-done" role="status">
          <span className="report-done-mark" aria-hidden="true">
            <Icon name="check" size={22} />
          </span>
          <div>
            <p className="report-done-title">Thanks — moderators will review it.</p>
            <p className="report-done-body">
              You can also block or mute {target.type === 'user' ? 'this account' : 'the author'} so you don’t have to see them while you
              wait. Reports are confidential: the person you reported isn’t told who sent it.
            </p>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Report ${target.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-signal" type="submit" form={formId} disabled={!reason || over || needsDetails || busy}>
            {busy && <span className="spinner" />}
            Send report
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="report-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="report-reasons">
          <legend className="report-legend">What’s wrong with it?</legend>
          {REPORT_REASONS.map((r) => (
            <label key={r.value} className="report-reason" data-checked={reason === r.value || undefined}>
              <input type="radio" name={`${uid}-reason`} value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
              <span className="report-reason-text">
                <span className="report-reason-label">{r.label}</span>
                <span className="report-reason-desc">{r.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {reason === 'self_harm' && (
          <p className="notice notice-amber report-note">
            If someone may be in immediate danger, please contact local emergency services as well — moderators can’t respond in real time.
          </p>
        )}
        <div className="field">
          <label htmlFor={detailsId}>
            Details <span className="report-optional">{reason === 'other' ? '(required)' : '(optional)'}</span>
          </label>
          <textarea
            id={detailsId}
            className="textarea"
            rows={3}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            aria-invalid={over || undefined}
            aria-describedby={`${detailsId}-hint`}
            placeholder="Anything that helps a moderator understand the context."
          />
          <div className="report-hint-row" id={`${detailsId}-hint`}>
            <span className="hint">
              Read the <Link to="/rules">community rules</Link>.
            </span>
            <span className={over ? 'meta counter-over' : 'meta'}>
              {len} / {LIMITS.reportDetails.max}
            </span>
          </div>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
