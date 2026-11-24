// floor.ts — when a payday counts as under the floor, or overdrawn.
//
// Money shows in whole dollars. A payday a few cents short — a card payment
// rounded up to the dollar, amounts counted by the day — shows as "$100" and
// mustn't be called under a $100 floor. Found 25 Nov 2026: on "whatever's
// spare" every payday closes at the floor, and cents under it showed as
// "$0 under your floor" on Cycle, Forecast and every expense in Plan › Savings.
// Every warning in the app asks these two instead of comparing cents.

export const FLOOR_SLACK_CENTS = 50

/** Under the floor by at least what shows as a dollar. */
export const underFloor = (cents: number, floorCents: number) => cents < floorCents - FLOOR_SLACK_CENTS
/** Overdrawn by at least what shows as a dollar. */
export const overdrawn = (cents: number) => cents < -FLOOR_SLACK_CENTS
