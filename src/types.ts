/** A set of 2D points as parallel coordinate arrays (region vertices or
 *  samples). Mirrors what hitandrun_sampler.m packs into its payloads. */
export interface Points {
  x: number[]
  y: number[]
}

/** The figure's parameter selections — part of the shared state. */
export interface Params {
  n: number
  convex: boolean
  local: boolean
}
