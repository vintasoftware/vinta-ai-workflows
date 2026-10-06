/** Public surface of the simulation unit (§13.1). */
export {
  simulate,
  DEFAULT_AGENT_TURN_MS,
  DEFAULT_GATE_MS,
  type CriticalPathStep,
  type DurationEstimates,
  type SimulateOptions,
  type SimulatedNode,
  type SimulationReport,
} from './simulate.ts'
export { formatSimulation, formatDuration } from './format.ts'
export { VirtualClock } from './clock.ts'
export { MeasuredPools, type PoolContention } from './pools.ts'
