# metal-1 engine measurements, 2026-10-16

Source baseline: `91f89fca67a2901a2dff9f9a7ff8159658f33a19`. No framework changes.
AMD EPYC 9454P: 48 physical cores / 96 threads, 251 GiB RAM. Node 24.18.0,
Postgres 16.15, `schedutil` governor, ordinary durable commits (`fsync`,
`synchronous_commit`, `full_page_writes` on). This is a shared host: observed
load averages were approximately 8–17, with no exclusive-core reservation. Another agent also ran a Node benchmark on
CPUs 0–3 during this series; these are contention-exposed exploratory results.

Affinity: observer/engine CPUs 0–3, four independent writer connections on
CPUs 4–7, Postgres CPUs 8–47. Logical CPU 0's SMT sibling is 48, CPU 8's is 56.
Postgres used its own `/tmp/lyn-perf-engine/pgdata` cluster, 1 GiB shared buffers,
500 connections, 20 replication slots and senders, logical WAL and commit
timestamps. Requested port 55433 was occupied; 55434 also failed to bind;
the isolated cluster used 56291. Other services were left untouched.

See [ENGINE.md](ENGINE.md) for recipes and metric definitions. Raw JSON,
telemetry, writer records, logs and CPU profiles remain uncommitted under
`/tmp/lyn-perf-engine/`. Load offers lasted 10–30 seconds (plus a 3-second smoke); each load point is one run,
not a statistically stable production capacity estimate. Startup is excluded.
CPU includes GC helpers; 100% means one logical CPU. RSS includes the harness.

## Load sweep

Latency is server commit until **all affected groups have delivered a snapshot
including that commit**, including coalesced writes (the conservative coverage
inference is described in ENGINE.md). It does not promise an individual message
for every write. CPU/RSS/WAL columns are the final cumulative CPU percentage,
peak sampled RSS MiB and peak sampled received-WAL lag KiB. Sampling can miss
stall peaks. Reruns/s averages actual processing through final delivery, including
drain, rather than just the writer's offer interval. Growing fixtures and retained
observer records influence costs. Profile runs are excluded from this table.

| Mix | Groups | Offer s | Offered/s | Committed/s | Reruns/s | All-delivery p50/p95/p99/max ms | CPU % | RSS MiB | WAL KiB | Drain s | Incomplete |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| broad | 100 | 10 | 5 | 5.1 | 509.6 | 23.3 / 34.7 / 36.5 / 36.5 | 18 | 176 | 0.0 | 0.01 | 0 |
| broad | 100 | 10 | 20 | 20.1 | 2005.8 | 15.5 / 24.3 / 38.0 / 95.4 | 36 | 186 | 0.0 | 0.02 | 0 |
| broad | 100 | 10 | 50 | 50.1 | 4571.5 | 19.1 / 165.1 / 223.6 / 247.3 | 75 | 182 | 0.2 | 0.01 | 0 |
| broad | 100 | 10 | 100 | 100.1 | 9678.0 | 16.1 / 51.2 / 86.3 / 116.0 | 104 | 224 | 0.0 | 0.01 | 0 |
| broad | 100 | 30 | 300 | 300.0 | 10453.1 | 44.7 / 60.9 / 73.8 / 135.4 | 105 | 253 | 0.4 | 0.02 | 0 |
| broad | 1000 | 10 | 1 | 1.1 | 1095.5 | 129.9 / 152.1 / 152.1 / 152.1 | 19 | 185 | 18.4 | 0.13 | 0 |
| broad | 1000 | 10 | 3 | 3.1 | 3071.9 | 103.3 / 138.8 / 139.4 / 139.4 | 38 | 225 | 0.0 | 0.10 | 0 |
| broad | 1000 | 10 | 10 | 10.1 | 9810.2 | 113.1 / 367.7 / 406.6 / 480.6 | 99 | 233 | 0.0 | 0.10 | 0 |
| broad | 1000 | 10 | 30 | 30.1 | 11735.7 | 160.4 / 400.5 / 774.9 / 866.6 | 111 | 239 | 0.0 | 0.15 | 0 |
| broad | 1000 | 30 | 100 | 100.0 | 8805.9 | 194.9 / 378.4 / 1007.8 / 1297.1 | 104 | 272 | 0.4 | 0.16 | 0 |
| broad | 10000 | 10 | 1 | 1.1 | 10072.0 | 918.6 / 1295.6 / 1295.6 / 1295.6 | 98 | 417 | 0.1 | 0.93 | 0 |
| broad | 10000 | 10 | 3 | 3.1 | 9332.9 | 6455.0 / 10377.0 / 10711.0 / 10711.0 | 109 | 445 | 135.8 | 2.16 | 0 |
| broad | 10000 | 10 | 10 | 10.1 | 10390.8 | 4885.0 / 9285.3 / 9684.6 / 9784.1 | 107 | 433 | 0.0 | 1.00 | 0 |
| broad | 10000 | 30 | 30 | 30.0 | 9988.8 | 1127.1 / 9066.9 / 10232.4 / 10532.7 | 108 | 584 | 0.1 | 1.01 | 0 |
| broad | 50000 | 10 | 1 | 1.1 | 4282.4 | 31112.4 / 36109.9 / 36109.9 / 36109.9 | 108 | 932 | 0.1 | 27.11 | 0 |
| broad | 50000 | 10 | 3 | 3.1 | 4241.2 | 33393.9 / 38059.5 / 38390.5 / 38390.5 | 107 | 978 | 0.3 | 28.73 | 0 |
| broad | 50000 | 30 | 10 | 10.0 | 5126.1 | 42276.4 / 55776.3 / 56975.1 / 57272.6 | 113 | 1557 | 0.3 | 27.38 | 0 |
| precise | 100 | 3 | 100 | 100.3 | 295.6 | 2.5 / 3.7 / 4.9 / 13.7 | 37 | 134 | 0.2 | 0.00 | 0 |
| precise | 100 | 10 | 100 | 100.1 | 294.5 | 2.2 / 3.9 / 6.4 / 11.9 | 24 | 178 | 0.0 | 0.00 | 0 |
| precise | 100 | 10 | 500 | 500.1 | 1471.0 | 1.7 / 4.1 / 9.1 / 16.7 | 64 | 159 | 0.4 | 0.00 | 0 |
| precise | 100 | 10 | 1500 | 1500.2 | 4399.6 | 1.6 / 3.9 / 39.0 / 129.2 | 88 | 173 | 0.5 | 0.00 | 0 |
| precise | 100 | 10 | 3000 | 2999.6 | 6665.8 | 25.9 / 61.5 / 86.7 / 150.9 | 115 | 243 | 1.2 | 0.01 | 0 |
| precise | 100 | 15 | 6000 | 5999.5 | 4039.3 | 49.3 / 112.7 / 196.4 / 530.0 | 111 | 290 | 4.3 | 0.03 | 0 |
| precise | 100 | 15 | 12000 | 11829.8 | 16.5 | 18407.6 / 26592.4 / 28643.6 / 30764.7 | 106 | 1317 | 9646.2 | 15.59 | 9 |
| precise | 1000 | 10 | 100 | 100.1 | 299.7 | 2.6 / 3.9 / 5.7 / 13.5 | 27 | 166 | 0.4 | 0.01 | 0 |
| precise | 1000 | 10 | 300 | 300.0 | 898.6 | 1.9 / 6.4 / 27.3 / 90.1 | 45 | 170 | 0.3 | 0.00 | 0 |
| precise | 1000 | 10 | 600 | 600.0 | 1796.9 | 3.0 / 227.5 / 450.9 / 980.8 | 72 | 266 | 1.5 | 0.00 | 0 |
| precise | 1000 | 10 | 1200 | 1200.0 | 3593.0 | 2.5 / 30.5 / 98.6 / 298.9 | 98 | 260 | 0.4 | 0.00 | 0 |
| precise | 1000 | 15 | 3000 | 3000.0 | 136.7 | 16295.4 / 24052.5 / 26649.0 / 28663.2 | 125 | 2417 | 255.5 | 13.94 | 0 |
| precise | 10000 | 10 | 20 | 20.1 | 60.2 | 12.7 / 15.3 / 17.6 / 23.6 | 26 | 285 | 0.1 | 0.01 | 0 |
| precise | 10000 | 10 | 50 | 50.1 | 150.1 | 9.7 / 12.9 / 14.3 / 34.0 | 51 | 285 | 0.0 | 0.01 | 0 |
| precise | 10000 | 10 | 100 | 100.1 | 300.2 | 6.9 / 10.7 / 69.1 / 129.0 | 62 | 304 | 0.6 | 0.01 | 0 |
| precise | 10000 | 10 | 200 | 200.1 | 598.6 | 9.1 / 240.1 / 354.6 / 581.9 | 91 | 317 | 0.5 | 0.03 | 0 |
| precise | 10000 | 30 | 300 | 300.0 | 621.1 | 10398.8 / 22105.2 / 22722.2 / 25560.5 | 129 | 2756 | 93.8 | 13.47 | 0 |
| precise | 50000 | 10 | 5 | 5.1 | 15.2 | 53.6 / 67.9 / 71.2 / 71.2 | 28 | 735 | 0.1 | 0.05 | 0 |
| precise | 50000 | 10 | 15 | 15.1 | 45.1 | 49.5 / 58.5 / 121.3 / 128.1 | 72 | 752 | 0.1 | 0.05 | 0 |
| precise | 50000 | 10 | 30 | 30.1 | 70.4 | 7565.7 / 11924.0 / 12337.6 / 12471.9 | 100 | 778 | 19.9 | 2.82 | 0 |
| precise | 50000 | 30 | 30 | 30.0 | 89.8 | 10172.6 / 19847.5 / 21294.6 / 22827.0 | 100 | 579 | 17.8 | 0.10 | 0 |
| precise | 50000 | 10 | 60 | 60.1 | 71.0 | 20174.2 / 24588.1 / 24934.7 / 25024.0 | 100 | 789 | 243.0 | 15.36 | 0 |
| precise | 50000 | 10 | 100 | 100.1 | 67.8 | 39125.2 / 43359.0 / 43701.9 / 43787.0 | 100 | 792 | 69.8 | 34.29 | 0 |
| precise | 50000 | 30 | 100 | 100.0 | 71.6 | 110301.9 / 123268.9 / 124373.7 / 124628.2 | 101 | 834 | 41.8 | 95.76 | 0 |

The failed 1,000-group precise / 6,000 writes/s / 15-second offer is also part
of the series: all 90,000 writes committed at 5,999.6/s, then the observer
exhausted Node's default ~4 GiB heap around 32 seconds after process start.
There is no successful latency result for that point. Its log and independent
writer record are retained. Small observer records cannot explain gigabytes of
retention; the engine's per-running-group batch queues and wave intermediates
are the primary suspect. The 10,000-group / 300/s run reached ~2.7 GiB RSS.

## One-commit fan-out

Median and maximum across five writes, after initialization. Pool and readers
are adapter options. All groups are distinct even when SQL/results coincide.

| Groups | Readers | Pool | All delivered median ms | Max ms |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | 40 | 36.5 | 56.4 |
| 100 | 4 | 40 | 16.8 | 46.8 |
| 100 | 8 | 40 | 16.2 | 30.3 |
| 100 | 16 | 40 | 14.8 | 27.8 |
| 1000 | 1 | 40 | 231.7 | 249.8 |
| 1000 | 4 | 40 | 119.7 | 149.5 |
| 1000 | 8 | 40 | 110.6 | 139.9 |
| 1000 | 16 | 40 | 111.7 | 148.0 |
| 5000 | 1 | 40 | 1070.8 | 1113.5 |
| 5000 | 4 | 40 | 468.0 | 563.3 |
| 5000 | 8 | 40 | 403.2 | 485.2 |
| 5000 | 16 | 40 | 388.5 | 476.4 |
| 20000 | 16 | 16 | 1775.5 | 1884.6 |
| 20000 | 1 | 40 | 5135.5 | 8078.3 |
| 20000 | 4 | 40 | 2085.9 | 2158.6 |
| 20000 | 8 | 40 | 1871.1 | 1979.8 |
| 20000 | 16 | 40 | 1807.7 | 1954.4 |

Pool constraint failure: `readers=16,max=4` never completed initialization:
19,988/20,000 groups delivered, leaving exactly 12 reader acquisitions stuck.
Postgres showed all four pool clients idle in snapshot transactions.
`max=8` also stalled. Small reproductions delivered 88/100 and 92/100
subscriptions, with 12 and 8 pool waiters respectively. The snapshot's asynchronous acquisition loop can count the
same idle capacity repeatedly, queue more opens than the pool can satisfy, and
then wait for reads that cannot start until that same snapshot releases clients.
These are failures, not slow timings. `max=16` completed. Keep pool capacity at
least as large as readers for this workload; concurrent waves need separate
reservation correctness too. No fix was applied during this series.

## Read tracking

Five warmed batch means, medians below. Equality: parameterized aggregate with
`where grp=$1`; join: two tables; broad: one table aggregate. These are means of
operations, not per-query tail latency. A scan matches one changed bucket.

| Operation | Equality µs | Join µs | Broad µs |
| --- | ---: | ---: | ---: |
| Raw SQL parse | 13.03 | 15.97 | 8.94 |
| Analyze SQL / dependency tree | 27.68 | 36.75 | 19.67 |
| Cached readsOf | 0.259 | 0.041 | 0.034 |
| Uncached readsOf | 28.57 | 38.67 | 20.12 |

Full `affects` scans: 100 groups 0.0259 ms; 1,000 groups 0.264 ms;
10,000 groups 2.637 ms; 50,000 groups 13.429 ms. Thus even the isolated match
loop limits 50,000 equality groups to ~74 batches/s before engine overhead.
The real engine's knee is lower.

## Profiles and improvement priorities

Profiles use `node --cpu-prof`; `engine-profile.ts` filters by the benchmark's
monotonic active-load/drain interval, excluding initialization and postprocessing.
Percentages below are weighted sample time; inclusive and self views overlap.

- `profile-precise-50000.cpuprofile`: `Engine.#receive` 97.39% inclusive;
  `PostgresAdapter.affects` 85.81% inclusive / about 71% self; `rowMatches`
  about 14% self. Parsing and database query execution are not this bottleneck.
- `profile-precise-100.cpuprofile`, 12,000/s offer: the `#runWave` continuation
  at engine.ts:193 takes 31.4% self, `#finish` 10.0%, matching 16.4% across
  affects/rowMatches, native `writeBuffer` 18.3%, GC 3.6%. The hot work shifts
  toward queued evaluation completion and replication/socket traffic.

- `profile-broad-50000.cpuprofile`, 10/s offer: the wave scheduling callback
  at engine.ts:170 takes 22.63% self, `#startWave` 9.87% self, native
  `writeBuffer` 17.92% self, reader release 3.71% self and GC 4.39%.
  The scheduling callback is 34.56% inclusive. Repeated whole-group scans and
  snapshot/read protocol work dominate once broad groups continually requeue.

Ranked proposals, **not implemented or measured improvements**:

1. Adapter-owned candidate lookup for invalidation. Avoid asking `affects` about
   every unrelated equality group. Keep Postgres-specific read indexing in the
   adapter; retain conservative fallback and core's database independence.
   This targets ~86% inclusive time at 50k groups; matching work could scale with
   the 1–3 candidates instead of 50,000. That is an algorithmic opportunity,
   not a measured end-to-end speedup.
2. Compact running-group invalidations and schedule a dirty-group queue. Preserve
   mutation token coverage and changing-read-set correctness while avoiding one
   Work allocation per running group per commit, whole-map scans per small wave,
   repeated flattening, and quadratic `rerun.includes` classification. This
   targets the observed heap failure and long broad refresh starvation.
3. Reduce per-evaluation protocol/transaction overhead and bound reader work.
   Fix acquisition reservations that cause the constrained-pool deadlock.
   Each handler currently performs setup/savepoint, SQL and savepoint release
   as separate round trips. Four readers capture most fan-out benefit; more
   connections alone do little. Also investigate coalescing replication feedback
   writes, since native socket writes are prominent at high write rates.

No prototype branch was created for this run: framework code stayed unchanged.
Repository-wide `pnpm typecheck` passed; 100 direct engine mutations settled
without errors. The engine/adapter sources were not edited, so the adapter
fuzzer was not required for this benchmark-only change.
