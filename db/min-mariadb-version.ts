// Single source of truth for the minimum MariaDB version this codebase
// supports. preflight.sh mirrors these values manually — drift between
// the TS source and the bash mirror is the bug class this constant
// prevents. When bumping, edit BOTH locations in the same commit.
//
// Why MariaDB 10.6 was chosen:
//   - DELETE...RETURNING and INSERT...RETURNING (10.5+)
//   - online ENUM-widening (10.5+)
//   - UNIQUE INDEX on STORED generated columns
//   - Stable behaviour of partial-unique-index emulation via STORED
//     generated column + UNIQUE NULL-distinct semantics
//
// References:
//   - scripts/preflight.sh gate 3.5
//   - scripts/pre-migrate-asserts.ts assert #1
//   - .notes/pages-cms-spec.md §1.4 MariaDB minimum

export const MIN_MARIADB_MAJOR = 10
export const MIN_MARIADB_MINOR = 6
