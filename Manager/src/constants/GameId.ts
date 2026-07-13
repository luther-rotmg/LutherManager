/** Special game location / realm IDs (used in HELLO and LOAD packets). */
export const GameId = {
  Tutorial:           -1,
  Nexus:              -2,
  RandomRealm:        -3,
  Vault:              -5,
  MapTest:            -6,
  VaultExplanation:   -8,
  NexusExplanation:   -9,
  QuestRoom:          -11,
  CheatersQuarantine: -13,
} as const;

export type GameIdName = keyof typeof GameId;
