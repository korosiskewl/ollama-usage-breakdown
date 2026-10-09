import { Dialog } from './Dialog';

// STUB — replaced by the moderation workstream.
export function ReportDialog({ target, onClose }: { target: { type: 'post' | 'user'; id: string; label: string }; onClose: () => void }) {
  return (
    <Dialog title={`Report ${target.label}`} onClose={onClose}>
      <p>Reporting is coming.</p>
    </Dialog>
  );
}
