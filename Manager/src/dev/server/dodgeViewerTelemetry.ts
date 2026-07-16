import type { AutoDodgeState, DodgeMovementIntentMode } from 'headless-client';

export interface DodgeViewerTelemetry {
  searchRevision: number;
  planRevision: number;
  searchPerformed: boolean;
  planReused: boolean;
  planCommitted: boolean;
  replanCause: AutoDodgeState['replanCause'];
  movementIntentMode: DodgeMovementIntentMode | null;
  safetyState: AutoDodgeState['safetyState'];
  retreatPenaltyScale: number;
  committedScore: number | null;
  proposedScore: number | null;
  comparisonHorizonMs: number | null;
  commandedSpeed: number;
  progressSpeed: number;
  firstControlHeading: number | null;
  headingChange: number | null;
  movementTargetDistance: number;
  timeSinceLastMovementCommandMs: number | null;
  lookaheadRevision: number;
  lookaheadChanged: boolean;
}

export function buildDodgeViewerTelemetry(
  state: AutoDodgeState | null,
): DodgeViewerTelemetry | null {
  if (!state) return null;
  return {
    searchRevision: state.searchRevision,
    planRevision: state.planRevision,
    searchPerformed: state.searchPerformed,
    planReused: state.planReused,
    planCommitted: state.planCommitted,
    replanCause: state.replanCause,
    movementIntentMode: state.movementIntentMode,
    safetyState: state.safetyState,
    retreatPenaltyScale: state.retreatPenaltyScale,
    committedScore: state.committedScore,
    proposedScore: state.proposedScore,
    comparisonHorizonMs: state.comparisonHorizonMs,
    commandedSpeed: state.commandedSpeed,
    progressSpeed: state.progressSpeed,
    firstControlHeading: state.firstControlHeading,
    headingChange: state.headingChange,
    movementTargetDistance: state.movementTargetDistance,
    timeSinceLastMovementCommandMs: state.timeSinceLastMovementCommandMs,
    lookaheadRevision: state.lookaheadRevision,
    lookaheadChanged: state.lookaheadChanged,
  };
}
