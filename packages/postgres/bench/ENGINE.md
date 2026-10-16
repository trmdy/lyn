# Engine benchmarks

These extend `latency.ts` with a process-isolated write generator, load telemetry,
fan-out sweeps and read-tracker microbenchmarks. No HTTP or browser is involved.
The benchmark drops `items` and `labels`: use a dedicated database.

Run Node 24+ against Postgres 14+ with logical replication, a superuser benchmark
connection and `track_commit_timestamp=on`. Configure `wal_level=logical`, adequate
replication slots and connections before starting Postgres.

```sh
export BENCH_DATABASE_URL=postgres://postgres@127.0.0.1:56291/lyn_engine_bench
mkdir -p /tmp/lyn-perf-engine
taskset -c 0-3 node packages/postgres/bench/engine-load.ts --groups 10000 --mix precise --rate 100 --seconds 30 > /tmp/lyn-perf-engine/load.log
taskset -c 0-3 node packages/postgres/bench/engine-load.ts --mode fanout --mix broad --groups 20000 --readers 8 --pool 40 --runs 5
taskset -c 0-3 node packages/postgres/bench/engine-load.ts --mode micro
taskset -c 0-3 node --cpu-prof --cpu-prof-dir=/tmp/lyn-perf-engine packages/postgres/bench/engine-load.ts --groups 50000 --rate 100 --seconds 10
node packages/postgres/bench/engine-results.ts /tmp/lyn-perf-engine/result-PID.json
node packages/postgres/bench/engine-profile.ts /tmp/lyn-perf-engine/PROFILE.cpuprofile /tmp/lyn-perf-engine/result-PID.json
```

The writer subprocess defaults to CPUs 4–7 (`--cpus`), with four independent
connections (`--writers`). Pin Postgres separately; the recorded metal-1 series
used CPUs 8–47. SMT siblings for CPU 0 and 8 are 48 and 56 respectively. The
JavaScript engine remains single-threaded despite its four-CPU affinity mask.
Never run two load/fan-out instances concurrently against the same database.
The recorded source can deadlock when `readers` exceeds `max`; the constrained
pool sweep records this failure. For reproducing working runs use `max >= readers`.
A constrained setup emits initialization progress, including pool waiters.

## Workloads and metrics

Precise groups have distinct arguments, with three groups per equality bucket
(the last bucket can have fewer). Each write changes one bucket. Broad groups
also have distinct arguments, with a three-way mix of table aggregates, joins
and range aggregates. Every write affects all groups. Initial rows number
`ceil(groups/3)` for precise and 16 for broad. Half the writes insert a row; half
update an existing row. The fixture therefore grows during a run. Each evaluation
returns a small object containing a sum and the maximum observed write sequence.
This measures many small results, not large result serialization or row patches.

The generator schedules an increasing write sequence at the requested rate.
Each writer waits for its own previous write to commit, then catches up to its
schedule. Thus writer capacity can fall below the requested rate; report the
actual completed count divided by writer elapsed time, and distinguish that
from engine receive/drain capacity. An overloaded generator can extend the run.
The generator and observer are separate Node processes. Adapter writes through
`engine.mutate` can be exercised separately with `--mode mutation`; the primary
load series uses direct driver writes, including autocommit overhead, and does
not measure mutation settlement throughput.

The adapter is wrapped only to count incoming batches, changes, matching calls
and the last received batch WAL position. Query handlers count evaluations.
Every second, telemetry samples `pg_current_wal_lsn()` minus that received
position, process CPU time, RSS, heap and pool waiters. This is received WAL lag,
not the replication slot's periodically acknowledged `confirmed_flush_lsn`.
It can include WAL unrelated to published row changes. Sampling is delayed by
event-loop stalls. RSS includes the benchmark's retained observations; it is
not exclusively framework memory. Telemetry is also appended to a per-process
JSONL file so samples survive an engine crash. CPU percentages use 100% for one logical CPU.

The callback decodes engine frames, recording actual message-delivery time.
Commit timestamps are retrieved from Postgres transaction IDs after the timed
run, avoiding a timestamp query on the write path. Processed records retain those
commit timestamps so analysis can subsequently run offline. Clock timestamps and Node's
monotonic epoch clock are on the same host. `latencyMs` describes unique delivered
`(subscription, latest-write-sequence)` observations; coalesced writes are absent.
`engine-results.ts` adds `coverage`: observing a sequence proves that commit
is included. It also covers writes in the same bucket whose COMMIT responses
reached the independent writer at least 1 ms before that sequence's server commit
timestamp. This avoids assuming that concurrent commit timestamps alone establish
visibility order. Each write is counted once per affected group; the last such
message supplies its all-groups latency, including superseded writes. Unprovable
coverage is explicitly incomplete rather than assigned a successful latency.
The 1 ms margin accommodates host clock calibration; timestamps still have
Postgres's microsecond resolution. Early/late thirds reveal latency growth.

Fan-out waits for initialization, commits one update, then waits for every
subscription's delivery, repeating five times by default. Its time starts at the
actual server commit timestamp. Initialization is excluded. Small fan-out
quantile sample counts support medians and ranges, not stable tail estimates.

Microbenchmarks warm each operation and report five repeated batch means in
nanoseconds per operation. `parse` calls libpg_query directly; `analyze` also
walks the SQL tree; cached `readsOf` binds parameters; uncached `readsOf` clears
the template cache on every call. `affectsScan:N` is the cost of one full scan
of N distinct equality read sets against one update with old and new rows.
Its unit is ns per entire scan, not per group. No database work is timed there.

Use increasing offered rates and inspect delivery coverage, early/late latency,
WAL lag growth and drain time together. Coalescing can keep replication caught
up while queries fall behind. A short sweep locates a candidate knee; longer
runs are required to establish a sustained limit. Profiles are attribution runs,
not timing baselines. `engine-profile.ts` weights V8 samples by time delta and
uses the result's monotonic-clock interval to exclude initialization and analysis
(the retained interval includes load and drain). Self and inclusive percentages
are separate views and must not be added together. Keep all raw logs/profiles outside Git.
