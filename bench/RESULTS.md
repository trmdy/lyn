# Timetrack production HTTP and SSE results

Measured 2026-10-16 on `trmd-metal-2`, framework commit `91f89fc`.
The bottleneck is the single Node process's main thread. At 10,000 connected
clients, encoding and writing the same update to thousands of sockets dominate.
The database and SQL read tracker are not the limiting resources in that case.

## Machine and method

- AMD EPYC 7401P: 24 physical cores, 48 hardware threads, approximately 252 GiB RAM.
- App: `0-3,24-27`; private Postgres: `4-11,28-35`; generator/browser: `12-23,36-47`.
  SMT siblings stay with the same process class. Other agents share the host;
  these are affinities, not exclusive CPU reservations.
- Node 24.18.0, pnpm 10.28.0, native PostgreSQL 17.11 with logical WAL,
  max_connections=500, default application pool of 20 and four snapshot readers.
- `pnpm --filter timetrack build`; production CLI on `127.0.0.1:14501`.
  Private database `lyn_timetrack` on `127.0.0.1:55432`.
- Original schema and seed plus `http-fixture.sql`: 50 users, 52,390 entries,
  four entries per weekday per user over a year. Generated entries concentrate
  in one project; original seed rows remain, including overlaps in Ada's week.
- Signed cookies come from `/login`. SSR measures complete response bodies.
  SSE clients subscribe to the real seven week-page queries without hydration
  fingerprints. At 1k–10k connections there are 500 query/session groups.
- HTTP points run for 15 seconds. Live write ladders run for 10 seconds and
  drain for five seconds. Each point starts a fresh app and uses a three-second
  signed-in SSR warmup. Profiled results are excluded from throughput tables.
- Raw logs, samples, resource readings, screenshots and profiles remain in
  `/tmp/lyn-perf-http/run-2/`. Earlier duplicate-agent evidence in the parent
  directory is not used in these tables.

## Measurements

All latency values are milliseconds. Results exclude warmup and profiled runs.

| Page | Concurrency | req/s | p50 / p95 / p99 | App CPU ms/req | Errors |
| --- | --- | --- | --- | --- | --- |
| week | 1 | 68.9 | 14.0 / 16.7 / 21.4 | 13.41 | 0 |
| week | 8 | 97.6 | 70.1 / 126.8 / 142.9 | 12.98 | 0 |
| week | 32 | 95.3 | 327.9 / 401.3 / 520.1 | 13.06 | 0 |
| week | 128 | 96.9 | 1290.4 / 1418.2 / 1466.0 | 13.09 | 0 |
| anonymous | 1 | 223.3 | 4.2 / 5.2 / 7.9 | 4.19 | 0 |
| anonymous | 8 | 300.5 | 26.0 / 33.7 / 40.6 | 4.07 | 0 |
| anonymous | 32 | 316.7 | 100.4 / 122.1 / 138.4 | 3.93 | 0 |
| anonymous | 128 | 301.0 | 414.2 / 470.2 / 534.3 | 4.31 | 0 |

| SSE clients | Connections ready/s | First data p50 / p95 / p99 | Subscribe POST p50 / p95 / p99 | App RSS MiB | Added KiB/client | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| 1000 | 366.9 | 79.6 / 247.6 / 292.3 | 31.7 / 55.2 / 90.4 | 378.0 | 45.4 | 0 |
| 5000 | 525.4 | 69.0 / 102.6 / 207.3 | 31.8 / 49.3 / 65.7 | 490.7 | 32.0 | 0 |
| 10000 | 559.7 | 65.9 / 97.4 / 135.2 | 30.4 / 44.8 / 54.9 | 661.5 | 33.1 | 0 |

| Clients | Write path | Writes/s offered | Delivery p50 / p95 / p99 | Max | Intermediate deliveries missing | Submitter settle p99 | Stale final clients | Unexpected / errors / unsettled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | mutate | 1 | 68.7 / 77.7 / 80.4 | 81.2 | 0.0% | 81.3 | 0 | 0 / 0 / 0 |
| 100 | mutate | 10 | 53.6 / 59.7 / 64.7 | 97.2 | 0.0% | 64.8 | 0 | 0 / 0 / 0 |
| 100 | mutate | 25 | 33.2 / 49.4 / 72.6 | 139.1 | 0.0% | 101.2 | 0 | 0 / 0 / 0 |
| 100 | mutate | 50 | 77.7 / 129.4 / 1590.9 | 5688.1 | 56.0% | 5590.5 | 0 | 0 / 0 / 0 |
| 100 | sql | 1 | 57.8 / 71.8 / 73.9 | 74.8 | 0.0% | — | 0 | 0 / 0 / 0 |
| 100 | sql | 10 | 49.2 / 57.3 / 62.2 | 66.0 | 0.0% | — | 0 | 0 / 0 / 0 |
| 100 | sql | 25 | 30.2 / 36.5 / 51.6 | 97.2 | 0.4% | — | 0 | 0 / 0 / 0 |
| 100 | sql | 50 | 42.0 / 79.9 / 100.1 | 106.3 | 47.8% | — | 0 | 0 / 0 / 0 |
| 1000 | mutate | 1 | 93.4 / 116.5 / 123.4 | 128.8 | 0.0% | 128.9 | 0 | 0 / 0 / 0 |
| 1000 | mutate | 10 | 63.6 / 100.1 / 128.3 | 152.1 | 0.0% | 143.1 | 0 | 0 / 0 / 0 |
| 1000 | mutate | 25 | 158.9 / 218.0 / 251.2 | 3306.0 | 54.8% | 3227.5 | 0 | 0 / 0 / 0 |
| 1000 | sql | 1 | 90.8 / 130.2 / 153.6 | 159.2 | 0.0% | — | 0 | 0 / 0 / 0 |
| 1000 | sql | 10 | 67.7 / 109.3 / 134.1 | 160.5 | 0.0% | — | 0 | 0 / 0 / 0 |
| 1000 | sql | 25 | 80.3 / 127.3 / 150.6 | 185.0 | 51.6% | — | 0 | 0 / 0 / 0 |
| 10000 | mutate | 1 | 337.2 / 577.2 / 625.0 | 767.1 | 0.0% | 767.2 | 0 | 0 / 0 / 0 |
| 10000 | mutate | 10 | 1411.1 / 3356.1 / 3772.2 | 11367.1 | 80.0% | 11767.3 | 0 | 0 / 0 / 0 |
| 10000 | sql | 1 | 329.2 / 573.1 / 632.4 | 734.4 | 0.0% | — | 0 | 0 / 0 / 0 |
| 10000 | sql | 10 | 386.5 / 719.1 / 837.8 | 919.0 | 83.0% | — | 0 | 0 / 0 / 0 |

| Concurrent writers | Settled mutations/s | HTTP p50 / p95 / p99 | Settled p50 / p95 / p99 | App CPU ms/mutation | Errors |
| --- | --- | --- | --- | --- | --- |
| 1 | 28.7 | 3.4 / 5.2 / 6.9 | 34.1 / 41.2 / 46.2 | 37.03 | 0 |
| 8 | 68.7 | 37.6 / 68.7 / 87.4 | 115.2 / 158.4 / 178.9 | 17.08 | 0 |
| 32 | 139.3 | 123.2 / 243.5 / 333.1 | 216.5 / 334.1 / 422.2 | 8.80 | 0 |


All 103 collected result records, including warmups, profiles and repeats, have
zero request/subscription errors, unexpected updates, missing settlements and
stale final values. Intermediate states coalesce under overload; the missing
percentage counts recipient deliveries, not lost final database state. The
write ladder stops after p99 exceeds one second or more than 5% of intermediate
recipient deliveries are missing. SQL at 100 clients / 25 writes/s missed one
intermediate value for all 53 affected clients, hence 0.4%.

The writer is one client in the open-loop mutation ladder. Its overlapping
mutations can hold updates and settlements until the outstanding mutations
finish. That explains why its settlement latency becomes much worse than most
recipients' delivery latency. The mutation-throughput test instead gives each
worker its own connection and waits for both HTTP completion and the matching
SSE `settled` message before issuing the next write. Its 128 observers and
same-row updates deliberately include contention and coalescing; 139 settled
mutations/s does not mean 139 individually delivered intermediate states/s.

Five additional ten-second SSR runs at concurrency 8, after the write tests,
returned 93.04, 93.18, 93.92, 93.85 and 95.20 req/s (median 93.85), with per-run
p99 149.6–154.8 ms. This fixture state includes budget alerts created during the
write tests, so it is a separate population from the initial HTTP matrix.

## Profile evidence

Profiles were collected with `node --cpu-prof` and clipped to each driver's
monotonic `profileWindow`, excluding startup, warmup, subscription and teardown.
Write windows include the drain period. Percentages below use active samples;
inclusive categories overlap and must not be summed. Socket-write columns are
self time, classified by their HTTP or pg ancestors.

| Path | devalue inclusive | Drizzle inclusive | Read tracker inclusive | Keyed diff inclusive | HTTP socket writes self | pg socket writes self |
| --- | --- | --- | --- | --- | --- | --- |
| SSR, concurrency 32 | 11.5% | 15.2% | 0.3% | — | 0.6% | 6.7% |
| 1k clients, 50 mutations/s | 22.2% | 15.9% | 3.6% | 0.9% | 12.6% | 9.2% |
| 10k clients, 10 mutations/s | 29.6% | 2.8% | 0.7% | 0.1% | 27.4% | 1.5% |

SSR spends 33.8% of active samples under React rendering, including 15.9% in
Timetrack's `wallClock` helper. `WeekView.spanOf` independently calls `dayOf`
and `minutesOf` on each endpoint; both perform the same timezone conversion.
The main thread was idle only 2.8% of the saturated SSR profile.

At 10k clients, `writev` alone is 27.5% self time; devalue `flatten` is 13.5%,
UTF-8 encoding 5.7%, and GC 6.7%. `Engine.#enqueue` encodes the per-connection
frame again for every recipient. Query sharing avoids thousands of SQL reads,
but it does not avoid thousands of serializations and socket writes.

The unprofiled 10k / 10 mutations/s write phase used approximately 1.44 app
CPU cores including worker/GC threads, 0.24 Postgres cores and 0.57 generator
cores. Generator scheduling lag was p99 1.6 ms, max 2.7 ms. The server-side
fan-out cost, rather than load-generator scheduling or database CPU exhaustion,
explains the slowdown. For comparison, saturated SSR used approximately 1.27
app cores, 1.13 Postgres cores and 0.14 generator cores.

Evidence files: `profile-ssr.cpuprofile`, `profile-writes.cpuprofile`,
`profile-writes-10000.cpuprofile`, their `*-summary.json` outputs, and
`cpu-summary.json` in the raw-results directory. Reproduce the attribution
using `http-profile.mjs`; native work may be charged to the JS caller by V8.

## Improvements ranked by expected impact

1. **Use multiple Node processes with connection affinity.** One main thread
   limits both SSR and SSE despite spare physical cores. Partitioning observers
   distributes the unavoidable per-socket writes. Route each SSE connection and
   its subscribe/mutate requests to the same process because client IDs and
   settlement state are process-local. Database work and replication feeds will
   be duplicated, so measure that cost before selecting a worker count.
2. **Reuse serialization for identical recipient frames.** About 30% of active
   CPU at 10k clients is under devalue, plus UTF-8 encoding and allocation cost.
   Cache only when message content and subscription IDs match; preserve unique
   mutation settlements, per-connection ordering and backpressure. This is a
   candidate optimization, not a measured speedup or an applied change.
3. **Convert calendar timestamps once per entry endpoint.** `wallClock` is the
   largest individual SSR function at 15.9%. Reusing the same conversion for
   day and minute calculations in `spanOf` is a small, local example-app change
   with no wire-protocol implications. Its exact gain still needs measurement.

## Validation and caveats

A real Chromium session passed signed-in SSR and hydration, received a direct
SQL description change in the DOM, saved a UI edit to Postgres, and retained it
after reload. No browser console or page errors occurred. See `browser.json`
and `browser-week.png`. This validates the browser path, but the latency tables
measure request submission to a Node client's SSE frame receipt, not paint or
post-commit-only latency.

This is loopback HTTP without TLS, with no simulated WAN or slow consumers.
Most points are single short runs on a shared host, not confidence intervals or
long-duration capacity/leak tests. At 1 write/s there are only ten independent
writes despite many correlated recipient samples. The subscription ramp is
bounded to 50 simultaneous opens, not a maximum admission-rate benchmark.
RSS deltas include caches and allocator retention and are not retained heap
measurements. There are 50 users, not 10,000 distinct authenticated users.

No framework or example source was modified. Only benchmark tooling, fixture
SQL, methods and this aggregate report are committed. Owned app servers,
generators and browser processes exited; the private Postgres was stopped and
ports 14501 and 55432 were verified free. No Docker container was created.
