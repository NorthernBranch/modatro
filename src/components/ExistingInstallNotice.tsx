import { Info } from 'lucide-react';

export function ExistingInstallNotice() {
  return (
    <div className="info-panel">
      <Info size={20} />
      <div>
        <strong>Already have mods installed?</strong>
        <p>
          If your existing mods, Steamodded or Lovely are outdated, we recommend starting with a
          fresh installation of Balatro. Modatro can try updating supported mods and prerequisites
          in place, but older setups may still have compatibility issues. Back up your saves and
          mods before starting fresh.
        </p>
      </div>
    </div>
  );
}
