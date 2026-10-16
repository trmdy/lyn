# Direct engine measurements on metal-1

2026-10-16, framework revision `91f89fc`. These are exploratory shared-host measurements, not isolated-machine regression baselines. Benchmark code and this report are on `perf-engine`; the reader-reservation prototype is separate on `perf-engine-pool-reservations` (commit `b5053f6`).

AMD EPYC 9454P: 48 physical cores / 96 hardware threads, 251 GiB RAM. Node 24.18.0, PostgreSQL 16.15. Affinity: engine 0–3, separate writer 4–7, PostgreSQL 8–47. Final tracker measurements use 0–3; initial tracker and prototype fuzzing used 52–55. Another agent was observed using engine affinity 0–3 concurrently. Host load was roughly 17–20 during early measurements.

Port 55433 and `/tmp/lyn-perf-engine/pgdata` were already occupied. This run used its own port 55483 and `/tmp/lyn-perf-engine/run-codex-55483/pgdata`, leaving other agents untouched. PostgreSQL used logical WAL, 20 replication slots/senders, 500 connections, 1 GiB shared buffers, commit timestamps, and default enabled fsync/synchronous_commit. Raw JSON, profiles, failed runs and runner scripts remain under `/tmp/lyn-perf-engine/run-codex-55483/`.

## Workload and interpretation

No HTTP. Direct Engine, PostgresAdapter, connect and subscribe; external SQL writers alternate single-row inserts/updates over eight connections (32 for the 10k/s stress run). A final engine.mutate checks the mutation path; mutation throughput/settlement is not benchmarked. Each group has distinct arguments and one subscriber on a single connection. Precise queries have an indexed bucket equality and affect 1–3 groups/write. Broad queries alternate unfiltered aggregate, join aggregate, and ordered top-row queries. Inserts grow the table. Default readers=4, pool=20. Results are small scalar objects, not large row patches.

Traced confirmations add pg_current_snapshot() to returned data. Offline analysis finds the first delivered snapshot covering each commit for every affected group, including coalesced commits. All-groups latency below is one sample per write, from its actual PostgreSQL commit timestamp until the last affected group covers it. Delivery clocks have millisecond resolution. Trace payloads add overhead; compare traced runs to traced runs. Each successful traced run had zero missing coverage and matched fresh SQL at completion.

## Traced confirmations

Latency columns are commit → all affected groups, in milliseconds. Rates are completed database writes during the offered window, not a claim the engine sustained that rate. CPU is process user+system time, where 100% means one core. Re-runs/s includes drain time; RSS is end-of-measurement and peak includes initialization.

| Mix | Groups | Offered/s | Completed/s | Seconds | p50 | p95 | p99 | Max | Re-runs/s | CPU % | RSS / peak MiB | Drain s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| broad | 100 | 200 | 200.0 | 30 | 25.0 | 38.9 | 51.4 | 101.4 | 10,162.5 | 104.5 | 287.1 / 652.6 | 0.3 |
| broad | 1,000 | 50 | 50.0 | 30 | 114.5 | 183.9 | 387.1 | 647.1 | 9,746.3 | 106.8 | 299.6 / 664.7 | 0.3 |
| broad | 1,000 | 500 | 491.6 | 30 | 188.3 | 526.9 | 794.3 | 1,074.7 | 5,552.7 | 107.3 | 394.4 / 664.0 | 0.5 |
| broad | 10,000 | 5 | 5.0 | 30 | 1,034.4 | 3,340.0 | 4,340.0 | 4,539.7 | 9,783.3 | 106.9 | 468.3 / 723.3 | 1.8 |
| broad | 50,000 | 1 | 1.0 | 30 | 30,463.1 | 42,463.5 | 43,462.4 | 43,462.4 | 5,613.0 | 105.9 | 1,124.8 / 1,127.8 | 17.1 |
| precise | 100 | 5,000 | 4,095.0 | 30 | 25.5 | 50.9 | 102.7 | 285.0 | 5,687.1 | 105.0 | 371.3 / 641.3 | 0.4 |
| precise | 100 | 10,000 | 9,932.0 | 20 | 24,628.0 | 33,799.7 | 35,429.0 | 36,731.5 | 18.8 | 105.7 | 1,219.7 / 1,219.7 | 20.3 |
| precise | 1,000 | 1,000 | 999.9 | 30 | 1.6 | 40.6 | 162.3 | 316.9 | 2,957.0 | 86.9 | 283.0 / 652.1 | 0.2 |
| precise | 1,000 | 1,500 | 1,464.8 | 30 | 864.7 | 6,168.5 | 7,356.7 | 8,760.6 | 1,171.3 | 120.2 | 1,158.5 / 1,158.5 | 0.3 |
| precise | 10,000 | 200 | 200.0 | 30 | 4.2 | 390.4 | 974.0 | 1,235.0 | 595.2 | 81.2 | 356.6 / 710.9 | 0.1 |
| precise | 50,000 | 10 | 10.0 | 30 | 45.2 | 51.6 | 63.5 | 72.8 | 29.7 | 43.8 | 796.2 / 915.6 | 0.1 |
| precise | 50,000 | 20 | 20.0 | 30 | 62.9 | 2,282.5 | 3,556.6 | 4,098.5 | 59.5 | 95.1 | 785.6 / 910.0 | 0.1 |

**Failed confirmation:** precise 10,000 groups, 500 writes/s, 30-second offer: Node aborted at ~45 seconds with heap exhaustion near its default 4 GiB limit. This is an overload failure, not a missing row in a successful-results average.

At 100 precise groups, ~4.1k writes/s completed with bounded tens-of-ms coverage latency; the eight writers dropped offers. With 32 writers, ~9.9k database writes/s caused tens-of-seconds engine delay. At 1k groups the tested knee lies between 1k and ~1.5k writes/s. At 10k groups, 200/s completed with transient stalls while 500/s exhausted the heap. At 50k, 10/s was responsive, 20/s already had multi-second stalls, and 50–200/s had severe backlog. These bracket observed degradation rather than establishing exact maximum sustainable rates.

Broad refresh work saturates around several thousand to ~10k re-runs/s, depending on group count and coalescing. High write throughput does not mean one re-run or one value delivery per commit per group. At 50k broad groups even ~1 write/s produced tens-of-seconds all-group latency. Finite 12–30-second offers demonstrate overload, backlog and an OOM, not a mathematical proof of unbounded latency.

## Received WAL position samples

Current WAL minus the last committed batch position received by the engine, bytes. This is not slot acknowledgement lag. Values before any batch was received (0/0) are excluded. Samples execute on the engine event loop: maxima are lower bounds when that loop stalls. PostgreSQL internal/checkpoint WAL can leave a residual gap after writes stop. Small WAL lag does not imply queries have caught up.

| Trial | Median bytes | Maximum sampled bytes | Last bytes | Longest sampler gap ms |
|---|---:|---:|---:|---:|
| extra-broad-100-200 | 200.0 | 200.0 | 48.0 | 1,002.0 |
| confirm-broad-1000-50 | 296.0 | 360.0 | 296.0 | 1,002.0 |
| extra-broad-1000-500 | 296.0 | 520.0 | 296.0 | 1,003.0 |
| confirm-broad-10000-5 | 48.0 | 104.0 | 104.0 | 1,001.0 |
| confirm-broad-50000-1 | 48.0 | 19,264.0 | 104.0 | 1,008.0 |
| confirm-precise-100-5000 | 876.0 | 8,232.0 | 2,136.0 | 1,017.0 |
| extra-precise-100-10000 | 158,820.0 | 6,021,168.0 | 147,776.0 | 4,206.0 |
| confirm-precise-1000-1000 | 200.0 | 912.0 | 96.0 | 1,005.0 |
| confirm-precise-1000-1500 | 2,444.0 | 26,808.0 | 48.0 | 1,166.0 |
| confirm-precise-10000-200 | 48.0 | 5,800.0 | 48.0 | 1,379.0 |
| confirm-precise-50000-10 | 48.0 | 48.0 | 48.0 | 1,017.0 |
| confirm-precise-50000-20 | 296.0 | 984.0 | 48.0 | 1,412.0 |

## Isolated fan-out

Median time in milliseconds to deliver one commit to every group, five writes after initialization, broad mix, pool=20. This isolates a wave from sustained overlapping waves.

| Groups | readers=1 | readers=4 | readers=8 | readers=16 | readers=16, pool=64 |
|---:|---:|---:|---:|---:|---:|
| 100 | 24.1 | 16.4 | 16.3 | 18.6 | 19.8 |
| 1000 | 279.4 | 121.6 | 130.8 | 138.8 | 192.0 |
| 10000 | 1,879.5 | 884.7 | 787.3 | 789.6 | 761.7 |
| 20000 | 4,436.3 | 2,068.1 | 1,880.6 | 1,784.4 | 1,782.8 |

More readers improve large fan-out over one reader, but gains flatten around 4–8. A larger pool does not consistently improve a single wave beyond its reader limit. Shared-host variation prevents interpreting small differences as regressions.

## Read tracking

Five repetitions; medians. Uncached readsOf clears the template cache each call. Cached readsOf includes parameter resolution and read-set creation; a cache hit performs no SQL parse. Analyze includes the libpg_query parse and Lyn AST analysis.

| Operation | Median cost |
|---|---:|
| analyze | 20.776 µs/query |
| uncached | 21.672 µs/query |
| cached | 0.268 µs/query |
| affects across 100 precise groups | 0.028 ms/batch |
| affects across 1,000 precise groups | 0.328 ms/batch |
| affects across 10,000 precise groups | 2.946 ms/batch |
| affects across 50,000 precise groups | 14.632 ms/batch |

## Profiles and bottlenecks

CPU profiles were collected separately with node --cpu-prof and summarized only between the logged measured-window timestamps. Profiled timings are excluded from throughput tables. Percentages are sampled wall time, and inclusive percentages overlap.

- Precise 50k groups / 100 offered writes/s: affects 53.1% self, receive 26.4% self, rowMatches 15.1% self. The one-second sampler first ran at ~62 seconds. Scanning every group for every commit monopolizes the event loop; the database still commits while deliveries wait.
- Precise 1k / 2k writes/s: finish 48.2% inclusive, affects 32.8% inclusive, rowMatches 22.3% self, receive 8.8% self, GC 13.2% self. Running groups enqueue every batch, then recheck them; finishing uses repeated filtering/includes over accumulated work. Queue churn and matching dominate.
- Broad 1k / 50 writes/s: writeBuffer 41.1% self, pg Client.query 45.6% inclusive. Each read uses session/savepoint setup, query execution and savepoint release: three client/server round trips, plus snapshot setup. More readers do not remove Node protocol work.

## Reader-reservation prototype

Original readers=16 with pool=4 failed initial subscription readiness after 120 seconds; pool=8 was independently reproduced and stopped after 44 seconds. pg.Pool schedules idle-client allocation for a later tick, so canGrow saw stale available capacity and reserved more connections than could be acquired. The snapshot held existing clients until all reads finished, causing deadlock.

The separate prototype compares idle plus creatable connections against pool.waitingCount, in addition to the reader limit. The first prototype only checked idle reservations, still failed with a growable pool=8, and was rejected. The final version covers both idle and creatable capacity. No framework change was applied on perf-engine.

| Variant | Groups | Readers | Pool | Median all-delivered ms |
|---|---:|---:|---:|---:|
| baseline-pool-1000-20 | 1000 | 16 | 20 | 104.4 |
| baseline-pool-20000-20 | 20000 | 16 | 20 | 1,792.5 |
| prototype-final-pool-100-4 | 100 | 16 | 4 | 16.4 |
| prototype-final-pool-1000-8 | 1000 | 16 | 8 | 107.2 |
| prototype-pool-100-4 | 100 | 16 | 4 | 17.6 |
| prototype-pool-1000-20 | 1000 | 16 | 20 | 111.5 |
| prototype-pool-1000-4 | 1000 | 16 | 4 | 119.1 |
| prototype-pool-20000-20 | 20000 | 16 | 20 | 1,773.7 |
| prototype-pool-20000-4 | 20000 | 16 | 4 | 1,939.6 |
| prototype-pool-20000-8 | 20000 | 16 | 8 | 1,843.8 |

The final prototype passed fuzz seed 9454, 300 steps: 147 subscriptions, 8,782 re-runs, and 4,614 delivered changes. Typechecking passed. It fixes a capacity/deadlock failure; the ordinary pool=20 comparisons do not establish a throughput speedup.

## Ranked next changes

1. Index invalidations by adapter-owned table/equality keys, preserving conservative fallbacks. Eliminate the O(groups × commits) scan for precise workloads. This has the highest expected impact at 10k–50k groups; core must stay database-agnostic.
2. Bound/coalesce queued work and retain commit frontiers/tokens without copying every batch into every running group. Avoid repeated quadratic membership checks in finish. This targets the heap failure, GC, and long commit-coverage delays. Preserve changed read dependencies, snapshot inclusion and mutation settling.
3. Improve the snapshot reader path: apply the tested reservation correction, then investigate batching session/savepoint protocol work while preserving error isolation and RLS. The prototype unblocks small pools; round-trip reduction remains unimplemented and unmeasured.

## Caveats and validation

One sample per sustained setting, 12-second exploratory sweeps and 20–30-second confirmations, five isolated fan-out repetitions. No exclusive CPU reservation, no confidence intervals, no universal hardware ceiling. Traced and untraced populations differ. Offered writes dropped by busy producers are reported, not counted as successful. Results include measurement decoding/retention; peak RSS includes initialization. Session is null, with no application RLS, network/HTTP/browser, large payload or subscriber-count fan-out test. Queries return small objects; query cost changes as inserts grow the fixture.

Early untraced trials exposed a harness teardown race: engine.busy can be false before the final smoke mutation arrives in replication. This was corrected by waiting for its received batch before stopping. Their measured windows precede the teardown errors; confirmations use corrected teardown and final-value checks. A 50k/200 untraced overload also reported a connection error during measurement and is not treated as a successful sustained rate. Initial WAL samples of 0/0 are excluded, and drain time was corrected to use the writer-recorded finish time rather than the possibly delayed child-exit callback.

Reproduce with engine-throughput.md. engine-throughput-profile.ts restricts profile aggregation to the measured window; engine-coverage.py accounts for coalesced commits. Raw failed runs remain available. The baseline framework was unchanged; the prototype was checked with the actual live-query fuzzer. Full repository typecheck passed.

Cleanup: owned PostgreSQL PID 379939 was stopped with pg_ctl against this run’s private data directory. All owned benchmark, writer, runner, and fuzz processes had exited. Other clusters were untouched; raw evidence was retained.
