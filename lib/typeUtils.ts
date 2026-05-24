/**
 * Compile-time exhaustiveness guard. Place after the last case in a
 * switch on a discriminated union so TypeScript errors at compile time
 * if a future variant is added to the union without a matching case.
 *
 * Without this guard, a missing case silently returns `undefined` from
 * the switch — which in a reducer corrupts state, and in a renderer
 * skips a branch with no diagnostic.
 *
 * Usage:
 *
 *     switch (action.type) {
 *       case 'foo': return doFoo()
 *       case 'bar': return doBar()
 *       default: return assertNever(action)
 *     }
 */
export function assertNever(x: never): never {
  throw new Error(
    `assertNever: unhandled discriminant — ${JSON.stringify(x)}`,
  )
}
