export const API_PHASES = Object.freeze({
  LOADING: 'loading',
  CURRENT: 'current',
  SAVING: 'saving',
  CONFLICT: 'conflict',
  OFFLINE_READ_ONLY: 'offline-read-only',
  AUTH_REQUIRED: 'auth-required',
});

export function createApiState({ snapshot = null, draft = null, pendingMutation = null } = {}) {
  return {
    phase: API_PHASES.LOADING,
    confirmed: snapshot,
    draft,
    pendingMutation,
    conflictReason: null,
    currentRevision: null,
  };
}

export function canMutate(state) {
  return state.phase === API_PHASES.CURRENT && Boolean(state.confirmed?.revision);
}

export function reduceApiState(state, event) {
  switch (event.type) {
    case 'LOAD_START':
      return { ...state, phase: API_PHASES.LOADING, conflictReason: null, currentRevision: null };
    case 'LOAD_SUCCESS':
      return {
        ...state,
        phase: API_PHASES.CURRENT,
        confirmed: event.snapshot,
        pendingMutation: null,
        conflictReason: null,
        currentRevision: null,
      };
    case 'LOAD_NOT_MODIFIED':
      if (!state.confirmed) return state;
      return {
        ...state,
        phase: API_PHASES.CURRENT,
        confirmed: { ...state.confirmed, fetchedAt: event.fetchedAt, etag: event.etag || state.confirmed.etag },
        pendingMutation: null,
        conflictReason: null,
        currentRevision: null,
      };
    case 'LOAD_OFFLINE':
      return { ...state, phase: API_PHASES.OFFLINE_READ_ONLY, pendingMutation: null };
    case 'AUTH_REQUIRED':
      return { ...state, phase: API_PHASES.AUTH_REQUIRED, pendingMutation: null };
    case 'AUTH_RECOVERY_START':
      return {
        ...state,
        phase: API_PHASES.LOADING,
        pendingMutation: null,
        conflictReason: null,
        currentRevision: null,
      };
    case 'DRAFT_CHANGED':
      if (state.phase === API_PHASES.OFFLINE_READ_ONLY || state.phase === API_PHASES.AUTH_REQUIRED || state.phase === API_PHASES.SAVING) {
        return state;
      }
      return { ...state, draft: event.draft };
    case 'SAVE_START':
      if (!canMutate(state)) return state;
      return { ...state, phase: API_PHASES.SAVING, pendingMutation: event.mutation };
    case 'SAVE_SUCCESS':
      return {
        ...state,
        phase: API_PHASES.CURRENT,
        confirmed: event.snapshot,
        draft: null,
        pendingMutation: null,
        conflictReason: null,
        currentRevision: null,
      };
    case 'SAVE_CONFLICT':
      return {
        ...state,
        phase: API_PHASES.CONFLICT,
        pendingMutation: null,
        conflictReason: 'revision',
        currentRevision: event.currentRevision || null,
      };
    case 'SAVE_REJECTED':
      return {
        ...state,
        phase: API_PHASES.CONFLICT,
        pendingMutation: null,
        conflictReason: 'rejected',
        currentRevision: null,
      };
    case 'SAVE_AMBIGUOUS':
      return {
        ...state,
        phase: API_PHASES.CONFLICT,
        pendingMutation: event.mutation,
        conflictReason: 'ambiguous',
        currentRevision: null,
      };
    case 'RESET':
      return createApiState();
    default:
      return state;
  }
}
