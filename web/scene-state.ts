import type { SceneState, WorldView } from '../shared/contracts';

export interface SceneDraft { worldId: string; revision: number; location: string; present: string[]; mode?: SceneState['mode']; situation?: string; playerPresent?: boolean }
export function sceneDraft(world: WorldView): SceneDraft {
  return { worldId: world.id, revision: world.revision, location: world.scene?.location || '', present: [...world.scene?.presentCharacterIds || []], mode: world.scene?.mode, situation: world.scene?.situation, playerPresent: world.scene?.playerPresent };
}
export function sceneDraftReducer(state: SceneDraft, action: { type: 'location'; value: string } | { type: 'present'; value: string[] } | { type: 'mode'; value: NonNullable<SceneState['mode']>; focusId?: string } | { type: 'reload'; world: WorldView }): SceneDraft {
  if (action.type === 'reload') return action.world.id === state.worldId ? sceneDraft(action.world) : state;
  if (action.type === 'mode') return { ...state, mode: action.value, ...(action.value === 'direct' && action.focusId ? { present: [action.focusId] } : {}) };
  return { ...state, [action.type]: action.value };
}
export function scenePatch(draft: SceneDraft, focusId?: string) {
  return { expectedRevision: draft.revision, scene: { location: draft.location.trim() || null, presentCharacterIds: draft.mode === 'direct' && focusId ? [focusId] : draft.present, ...(draft.mode ? { mode: draft.mode } : {}), ...(draft.situation !== undefined ? { situation: draft.situation } : {}), ...(draft.playerPresent !== undefined ? { playerPresent: draft.playerPresent } : {}) } };
}
