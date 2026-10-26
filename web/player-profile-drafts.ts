import type { PlayerProfile } from '../shared/contracts';

export interface ProfileDraft { selected: PlayerProfile | null; name: string; persona: string }
export const profileDraft = (selected: PlayerProfile | null): ProfileDraft => ({ selected, name: selected?.name || '', persona: selected?.persona || '' });
export const profileDirty = (draft: ProfileDraft) => draft.name !== (draft.selected?.name || '') || draft.persona !== (draft.selected?.persona || '');

/** Unsaved text survives navigation, but never crosses API clients or world editors. */
let nextStoreId = 0;
export class ProfileDrafts {
  readonly key = ++nextStoreId;
  private drafts = new Map<string, ProfileDraft>();
  current: ProfileDraft = profileDraft(null);
  write(draft: ProfileDraft) { this.current = draft; this.drafts.set(draft.selected?.id || '', draft); return draft; }
  select(profile: PlayerProfile | null) { return this.write(this.drafts.get(profile?.id || '') || profileDraft(profile)); }
  saved(profile: PlayerProfile, originalId = this.current.selected?.id || '') {
    this.drafts.delete(originalId);
    return this.write(profileDraft(profile));
  }
  remove(id: string) { this.drafts.delete(id); return this.select(null); }
}
const clients = new WeakMap<object, Map<string, ProfileDrafts>>();
export function profileDrafts(client: object, worldId = '') {
  let worlds = clients.get(client);
  if (!worlds) { worlds = new Map(); clients.set(client, worlds); }
  let drafts = worlds.get(worldId);
  if (!drafts) { drafts = new ProfileDrafts(); worlds.set(worldId, drafts); }
  return drafts;
}
