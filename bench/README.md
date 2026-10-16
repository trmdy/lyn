# Timetrack HTTP and live-data benchmarks

Run `http.mjs` against an isolated production build of `examples/timetrack`.
The harness uses the app's signed login cookie, the real seven week-page queries,
and the framework's devalue wire codec. It changes fixture entry descriptions;
never point it at a database containing data you need to preserve.

## Fixture and process isolation

Create a private Postgres 14+ database with logical WAL enabled. Apply
`examples/timetrack/db/schema.sql`, then `examples/timetrack/db/seed.sql`, then
`bench/http-fixture.sql`, using `psql -v ON_ERROR_STOP=1`. The last file expects
exactly the original three seed users. It adds 47 users, project memberships,
and four two-hour entries per weekday per user for a year. These generated
entries use one project, deliberately stressing its real budget aggregation.
The date range is fixed for reproducibility. Seed data still depends on the
server's current date.

Build with `pnpm --filter timetrack build`. Start the production CLI from
`examples/timetrack`, with `DATABASE_URL`, `NODE_ENV=production`, and `PORT`.
Assign the server, Postgres, and generator disjoint physical cores, including
SMT siblings. On metal-2 the CPU sets used were:

| Process | Logical CPUs | Physical cores |
| --- | --- | --- |
| App | `0-3,24-27` | 0–3 |
| Postgres | `4-11,28-35` | 4–11 |
| Generator | `12-23,36-47` | 12–23 |

The app is one Node process; CPU affinity does not create multiple workers.
Use a unique free port, record every owned PID, and terminate only those PIDs.

```sh
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/lyn_timetrack
export BASE_URL=http://127.0.0.1:14501
export SERVER_PID=12345
taskset -c 12-23,36-47 node bench/http.mjs http /week/2026-10-12 8 15
taskset -c 12-23,36-47 node bench/http.mjs http / 8 15
taskset -c 12-23,36-47 node bench/http.mjs capacity 1000
taskset -c 12-23,36-47 node bench/http.mjs writes 1000 mutate 10 10
taskset -c 12-23,36-47 node bench/http.mjs writes 1000 sql 10 10
taskset -c 12-23,36-47 node bench/http.mjs throughput 128 8 15
```

## Workloads and evidence

| Workload | Driver | Metric and correctness |
| --- | --- | --- |
| Signed-in SSR and anonymous SSR | `http PATH CONCURRENCY SECONDS` | Full-body latency, successful req/s, status/errors, app process CPU ms/request |
| Connection capacity | `capacity CLIENTS` | First-data and all-seven-data latency, subscribe POST latency, connection ramp throughput, incremental app RSS |
| Write fan-out | `writes CLIENTS mutate\|sql RATE SECONDS` | Open-loop request-start-to-recipient-frame latency, missing intermediate values, unexpected messages to unaffected clients, HTTP errors and settled frames |
| Mutation with settle | `throughput CLIENTS CONCURRENCY SECONDS` | Closed-loop completed `settled` frames/s, HTTP and settled latency; each worker waits for both before its next request |
| Saturation attribution | Same driver with server `node --cpu-prof` | Sampled CPU attribution; exclude profiled timings from throughput comparisons |

There are no performance budgets. HTTP errors, subscription errors, unexpected
updates and missing settlements are correctness failures; missing intermediate
values during overload can instead be valid coalescing. Inspect both counters.
An open-loop ladder stops being useful when p99 exceeds one second or more than
5% of intermediate recipient deliveries are missing. This is an exploration
cutoff, not a product latency budget.

Half the SSE clients share Ada's current benchmark week. Others mix 50 sessions
and four weeks, including Ada on other weeks. Group identity includes session;
this measures many connections sharing hundreds of groups, not 10,000 distinct
users. At 1,000, 5,000 and 10,000 clients there are exactly 500 groups
(50 sessions × six shared queries, plus 200 week/session pairs). At 100
clients there are 290 groups. The first client submits mutations. Subscriptions omit hydration fingerprints, measuring cold initial-data delivery.
All subscriptions have a real SSE
connection and receive their initial data before writes start. A priming update
runs first so initial budget alerts do not contaminate the unaffected-client
check. Every benchmark write updates one completed entry; the app's budgetWatch
effect remains enabled. Throughput mode deliberately measures same-row write
contention as well as the settle path.

Percentiles use nearest ranked observations. Write latencies are recipient
observations, correlated across clients; report write count as well as recipient
count. A description token identifies the value that actually arrived. Each write run
also compares every affected client's last observed description with the final
database value after draining for five seconds; `staleFinal` must be zero. Values
coalesced away are counted as missing, never assigned a fictitious latency.
Delivery means a Node SSE consumer received the frame, not browser rendering or
paint. The frame timestamp is taken before decoding its devalue payload. The write timestamp precedes HTTP/SQL submission, so it includes write execution
and transport rather than measuring only the interval after commit.

CPU comes from Linux `/proc/PID/stat` user plus system ticks, assuming Linux
`CLK_TCK=100`; it excludes Postgres and the generator. RSS is sampled from
`/proc/PID/status`, without forcing GC: incremental bytes/connection is an
estimate and includes caches, allocator retention and shared query groups.
Capacity opens batches of 50 and holds all clients for three seconds before the
memory sample. Ramp throughput excludes that hold; it is attained throughput
under this admission policy, not a measured maximum subscribe rate.

For comparable series use the same commit, fixture, Node/Postgres versions,
CPU sets, production build, warming policy, durations and driver. Restart and
warm the app before each independent live-data run. Keep raw JSONL, server logs,
resource samples and `.cpuprofile` files outside Git in `/tmp/lyn-perf-http/`.
On a shared host, one short run per point cannot establish a stable baseline or
confidence interval. Repeat the matrix for that purpose.

Afterward stop owned load generators and app servers, stop the private Postgres
with its own `pg_ctl -D ... stop`, or remove only the Docker container you created.
Retain the logs and profiles.

## Full suite and profiles

The suite starts and stops only its own app and generator PIDs. Postgres must
already be running and pinned. It checks the app port is free before each run.
Every point uses a fresh app, a three-second signed-in SSR warmup, and a separate
measurement driver. The HTTP matrix is 15 seconds per point; the write ladder
is 10 seconds plus a five-second drain. These short runs locate saturation;
they are not sustained-load or leak tests.

```sh
PG_PID=12345 RESULTS_DIR=/tmp/lyn-perf-http/my-run BENCH_PORT=14501 \
  DATABASE_URL=postgresql://postgres@127.0.0.1:55432/lyn_timetrack \
  python3 bench/http-suite.py
node bench/http-profile.mjs /tmp/lyn-perf-http/my-run/profile-ssr.cpuprofile \
  /tmp/lyn-perf-http/my-run/profile-ssr.jsonl
python3 bench/http-report.py /tmp/lyn-perf-http/my-run
```

`APP_CPUS` and `LOAD_CPUS` override the documented CPU sets. `PG_PID` is for
resource sampling; the suite does not start, pin or stop Postgres. Use a fresh
`RESULTS_DIR` per suite. Omitting it creates a timestamped directory. Stop the
private database yourself after all diagnostics finish.

`SAMPLES_FILE` makes the individual driver preserve the latency observations.
The suite sets it automatically. CPU profiles are clipped to `profileWindow`
from the corresponding JSONL, using the shared host's monotonic clock; startup,
login, warmup and subscription ramp are excluded. Write profile windows include
the five-second drain. Self-time percentages are exclusive; inclusive stack
percentages overlap and must not be added.

`http-browser.mjs` independently verifies signed-in SSR, hydration, a direct SQL
update reaching the DOM, a UI edit persisting, and the edited value surviving a
reload. It needs Playwright (or `PLAYWRIGHT_MODULE` pointing at its module) and
an installed Chromium (`CHROMIUM_PATH` can select it). Run it after measurement,
with `BASE_URL`, `DATABASE_URL` and `RESULTS_DIR` set. This is a browser correctness
check; the load-test latency remains SSE frame receipt, not browser paint.

Keep `*.cpuprofile`, JSONL, per-observation JSON, screenshots and process logs in
`/tmp/lyn-perf-http/`. Only scripts, fixture SQL, methods and compact conclusions
belong in Git. No framework code is changed by these benchmarks.
