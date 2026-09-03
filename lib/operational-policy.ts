export type StrategyRequirement = {
  id: string;
  active: boolean;
  lookbackTradingDays: number;
  outputHorizonTradingDays: number;
};

export const OPERATIONAL_POLICY_VERSION = "operational-retention-v1";
export const OPERATIONAL_RETENTION_FLOOR = 300;
export const OPERATIONAL_SAFETY_BUFFER_DAYS = 60;

// Only active, implemented strategies participate. UI-only locked horizons are
// declared separately so enabling them requires an explicit retention review.
export const STRATEGY_REQUIREMENTS: readonly StrategyRequirement[] = Object.freeze([
  { id: "daily-rule-v1", active: true, lookbackTradingDays: 1, outputHorizonTradingDays: 0 },
  { id: "model-horizon-5", active: false, lookbackTradingDays: 0, outputHorizonTradingDays: 5 },
  { id: "model-horizon-10", active: false, lookbackTradingDays: 0, outputHorizonTradingDays: 10 },
  { id: "model-horizon-20", active: false, lookbackTradingDays: 0, outputHorizonTradingDays: 20 },
]);

export function operationalRetentionPolicy(requirements: readonly StrategyRequirement[] = STRATEGY_REQUIREMENTS) {
  const active = requirements.filter((strategy) => strategy.active);
  const strategyMaxLookback = Math.max(0, ...active.map((strategy) => strategy.lookbackTradingDays));
  const forecastMaxHorizon = Math.max(0, ...active.map((strategy) => strategy.outputHorizonTradingDays));
  const requiredWithBuffer = strategyMaxLookback + forecastMaxHorizon + OPERATIONAL_SAFETY_BUFFER_DAYS;
  return Object.freeze({
    version: OPERATIONAL_POLICY_VERSION,
    strategyMaxLookback,
    forecastMaxHorizon,
    safetyBufferDays: OPERATIONAL_SAFETY_BUFFER_DAYS,
    retentionTradingDays: Math.max(OPERATIONAL_RETENTION_FLOOR, requiredWithBuffer),
  });
}

export const OPERATIONAL_RETENTION = operationalRetentionPolicy();

export function assertRetentionCoversStrategies(retentionTradingDays: number, requirements: readonly StrategyRequirement[] = STRATEGY_REQUIREMENTS) {
  const required = operationalRetentionPolicy(requirements).retentionTradingDays;
  if (!Number.isInteger(retentionTradingDays) || retentionTradingDays < required) {
    throw new Error(`Operational retention ${retentionTradingDays} is below the required ${required} trading days`);
  }
}
