import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';

export const CREATOR_ANNOUNCEMENT_ID = 'mod-creator-introduction';
export function CreatorAnnouncement({
  ready,
  dismissed,
  pending,
  dismiss,
}: {
  ready: boolean;
  dismissed: boolean;
  pending: boolean;
  dismiss: (openSettings: boolean) => Promise<boolean>;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ready || dismissed || visible) return;
    // Child pages can own native dialogs too. Wait until all of them are closed.
    const check = () => {
      if (!document.querySelector('dialog[open]')) setVisible(true);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    const frame = requestAnimationFrame(check);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ready, dismissed, visible]);
  if (!ready || dismissed || !visible) return null;
  const close = (open: boolean) => {
    void dismiss(open).then((saved) => {
      if (saved) setVisible(false);
    });
  };
  return (
    <Dialog
      title="New: Experimental Mod Creator"
      onClose={() => close(false)}
      dismissible={!pending}
    >
      <div className="creator-announcement">
        <p>Make something of your own with dedicated Joker, Deck and Voucher builders.</p>
        <p>
          Configure effects and starting deck composition, choose built-in artwork or upload your
          own images.
        </p>
        <p>Go to Settings → Experimental features → Mod Creator.</p>
        <p className="banner subtle">
          This feature is experimental. Back up your Balatro saves before testing created mods.
        </p>
        <div className="dialog-footer">
          <button
            className="button button-secondary"
            disabled={pending}
            onClick={() => close(false)}
          >
            Got it
          </button>
          <button className="button button-primary" disabled={pending} onClick={() => close(true)}>
            {pending ? 'Saving…' : 'Open experimental settings'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
