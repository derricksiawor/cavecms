// Vitest global setup. Currently a no-op for the unit suite; integration suite
// reuses this file for env propagation. Pool teardown is handled per-test-file
// to avoid forcibly closing the shared mysql2 pool while other tests still hold it.
export {}
