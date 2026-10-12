import type { InstallationRecord, AppState } from './model';
import type { Selection, ProfileSummary } from './features';

export function selection(records: InstallationRecord[]): Selection {
  return records
    .map((r) => ({ id: r.modId, enabled: !r.disabled }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function profileSummary(state: AppState, unmanagedCount = 0): ProfileSummary | undefined {
  if (!state.profiles) return undefined;
  const desired = state.profiles.items.find((p) => p.id === state.profiles!.activeId)!.selection;
  const actual = selection(state.installations);
  const ids = new Set([...desired, ...actual].map((v) => v.id));
  const differences = [...ids].filter(
    (id) => desired.find((v) => v.id === id)?.enabled !== actual.find((v) => v.id === id)?.enabled,
  );
  return { ...state.profiles, unsaved: differences.length > 0, differences, unmanagedCount };
}
