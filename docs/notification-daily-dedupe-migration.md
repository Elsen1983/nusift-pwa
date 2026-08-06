# Daily digest idempotency rollout

`Notification.dedupeKey` is a nullable PostgreSQL-unique key used for new
`DAILY_DIGEST` rows. Its deterministic format is:

```text
DAILY_DIGEST:<userId>:<UTC-calendar-date>
```

The day boundary is explicitly UTC. Both the sender's legacy lookup and the
new key use the UTC calendar date (`getUTCFullYear()`, `getUTCMonth()`, and
`getUTCDate()`), avoiding divergent keys across serverless instances. The key
is one digest per user/day; the schedule slot is not part of deduplication.

## Required rollout order

The application code that writes `dedupeKey` **must not be deployed before**
Prisma migration
`20260806000000_add_notification_dedupe_key` has been applied to the intended
database. The nullable column and unique index must exist first.

1. Confirm backup/rollback readiness.
2. Run `npx prisma migrate deploy` against the intended database.
3. Confirm migration `20260806000000_add_notification_dedupe_key` is applied.
4. Confirm `Notification.dedupeKey` and its unique index exist.
5. Deploy the application code.
6. Run a controlled daily-digest smoke test.
7. Verify one inbox row and at most one push attempt for a duplicate/replayed invocation.
8. Verify telemetry classifies the losing invocation as already notified.

The forward migration adds the nullable column and a unique index. Existing
rows are not rewritten or backfilled. PostgreSQL permits multiple `NULL`
values in a unique index, so legacy rows remain valid. During rollout, the
existing per-user/day lookup remains as a compatibility optimization and
recognizes legacy same-day rows that do not yet have a key. New rows are
claimed atomically by the unique key, and a Prisma `P2002` conflict targeting
`dedupeKey` is treated as already notified without push delivery.

No production migration or database was accessed during implementation.
