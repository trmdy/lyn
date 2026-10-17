# Lyn vs a hand-written Rust live server

Same workload, same Postgres, same load generator, same pinned cores.

- **Rust server** (`server/`): axum + tokio-postgres (16 pipelined connections, prepared statements) + pgoutput logical replication. Changes are indexed by `grp`; a changed group re-runs once and the encoded SSE frame is shared by every subscriber. No auth, RLS, sessions, snapshot consistency, diffs or optimistic-update settling. This is the specialised upper bound, not a framework.
- **Lyn app** (`lyn/`): `lyn()` on Hono, the Postgres adapter, a `vs:items` query, a `vs:rename` mutation and a React page using `useQuery` (streamed SSR). `/api/items` is a plain Hono route on `pg`.
- **Load generator** (`load/`): raw HTTP/1.1 over tokio. Writes are open-loop at a fixed rate through each server's mutation endpoint. Delivery latency runs from a write's scheduled time to the SSE frame that contains its unique label.

Workload: `items(id, grp, label, val)`, 10,000 groups of 20 rows, replica identity full.

| Scenario | What happens |
| --- | --- |
| `api` | `GET /api/items?grp=N`, 256 keep-alive connections |
| `page` | Server-rendered HTML list of the group (Lyn: React streaming SSR with hydration data) |
| `shared` | 10,000 SSE clients on one group; writes rename rows in that group |
| `precise` | 10,000 SSE clients, each on its own group; writes hit random groups |

Run: `./run.sh` on Linux (needs `cargo build --release`, `pnpm install`, Postgres 16 binaries). Postgres runs on CPUs 16–31, the server on CPU 8 (`*1`) or 8–15 (`*8`), the load generator on 32–47. Each live rate gets a fresh server; rates step up until delivery falls below 95%, p99 passes 5 s or writes fall behind.

## Results: metal-1 (AMD EPYC 9454P), 2026-10-17

Raw data: `results-metal-1.jsonl`. Server and Postgres CPU are measured from `/proc` during the run.

## HTTP (256 concurrent, 15 s)
| config | path | req/s | p50 ms | p99 ms | server cores | pg cores | req/s per server core |
|---|---|---|---|---|---|---|---|
| rust1 | /api/items | 38,354 | 7.07 | 8.49 | 1.0 | 1.6 | 38,354 |
| rust1 | /page | 35,763 | 7.58 | 9.15 | 1.0 | 1.68 | 35,763 |
| rust8 | /api/items | 208,099 | 1.15 | 3.28 | 7.45 | 6.67 | 27,933 |
| rust8 | /page | 189,147 | 1.23 | 4.08 | 7.17 | 5.77 | 26,380 |
| lyn1 | /api/items | 14,880 | 16.8 | 22.0 | 1.0 | 2.39 | 14,880 |
| lyn1 | / | 1,807 | 133.76 | 227.58 | 1.0 | 0.94 | 1,807 |
| lyn8 | /api/items | 15,395 | 16.35 | 19.14 | 1.03 | 2.4 | 14,947 |
| lyn8 | / | 2,145 | 116.8 | 141.18 | 1.37 | 0.93 | 1,566 |

## shared
| config | writes/s asked | achieved | deliveries/s | delivered | p50 ms | p99 ms | max ms | write p50 ms | server cores | pg cores | RSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rust1 | 10 | 10 | 98,582 | 1.000 | 81.34 | 168.7 | 206.08 | 2.55 | 0.87 | 0.0 | 348 |
| rust1 | 50 | 50 | 487,639 | 1.000 | 144.0 | 286.46 | 307.2 | 4.26 | 0.87 | 0.03 | 361 |
| rust1 | 100 | 100 | 745,054 | 0.776 | 320.77 | 781.31 | 902.66 | 8.5 | 0.88 | 0.05 | 370 |
| rust8 | 10 | 10 | 89,716 | 0.980 | 24.11 | 1879.04 | 2639.87 | 2.4 | 3.04 | 0.07 | 324 |
| rust8 | 50 | 50 | 493,408 | 1.000 | 12.88 | 45.09 | 132.22 | 2.17 | 5.4 | 0.03 | 341 |
| rust8 | 100 | 100 | 985,103 | 0.999 | 16.96 | 46.88 | 142.21 | 2.99 | 6.47 | 0.05 | 346 |
| rust8 | 200 | 200 | 1,939,352 | 0.984 | 17.77 | 73.47 | 392.19 | 3.49 | 6.73 | 0.08 | 370 |
| rust8 | 400 | 369 | 3,522,896 | 0.965 | 1286.14 | 2455.55 | 2979.84 | 1287.17 | 6.27 | 0.15 | 374 |
| rust8 | 800 | 415 | 3,973,529 | 0.966 | 6438.91 | 13803.52 | 14311.42 | 6418.43 | 6.88 | 0.17 | 372 |
| lyn1 | 10 | 9 | 81,262 | 0.953 | 739.33 | 1244.16 | 1376.26 | 373.76 | 0.83 | 0.01 | 906 |
| lyn8 | 10 | 9 | 82,593 | 0.969 | 636.93 | 945.66 | 1142.78 | 342.53 | 1.04 | 0.01 | 987 |

## precise
| config | writes/s asked | achieved | deliveries/s | delivered | p50 ms | p99 ms | max ms | write p50 ms | server cores | pg cores | RSS MB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rust1 | 200 | 200 | 197 | 1.000 | 1.8 | 2.4 | 6.48 | 1.41 | 0.06 | 0.13 | 348 |
| rust1 | 1000 | 1000 | 986 | 1.000 | 1.81 | 4.19 | 11.61 | 1.54 | 0.14 | 0.48 | 350 |
| rust1 | 2000 | 2000 | 1,972 | 1.000 | 1.66 | 9.71 | 63.33 | 1.39 | 0.24 | 0.77 | 348 |
| rust1 | 5000 | 5000 | 4,930 | 1.000 | 1.61 | 4.56 | 6705.15 | 1.25 | 0.46 | 1.36 | 349 |
| rust1 | 10000 | 9999 | 9,858 | 1.000 | 1.62 | 35.58 | 4505.6 | 1.22 | 0.74 | 2.21 | 348 |
| rust8 | 200 | 200 | 197 | 1.000 | 2.35 | 2.96 | 6.78 | 1.94 | 0.08 | 0.13 | 363 |
| rust8 | 1000 | 1000 | 986 | 1.000 | 1.24 | 2.85 | 3.94 | 0.9 | 0.31 | 0.46 | 360 |
| rust8 | 2000 | 2000 | 1,971 | 1.000 | 1.73 | 3.3 | 9.54 | 1.44 | 0.49 | 0.74 | 360 |
| rust8 | 5000 | 5000 | 4,930 | 1.000 | 1.6 | 3.18 | 3956.74 | 1.2 | 1.09 | 1.38 | 361 |
| rust8 | 10000 | 9999 | 9,859 | 1.000 | 1.5 | 341.5 | 4636.67 | 1.08 | 1.31 | 2.35 | 360 |
| lyn1 | 200 | 200 | 197 | 1.000 | 3.24 | 13.44 | 27.76 | 1.73 | 0.33 | 0.08 | 711 |
| lyn1 | 1000 | 1000 | 986 | 1.000 | 2.79 | 23.07 | 52.86 | 1.95 | 0.67 | 0.85 | 862 |
| lyn1 | 2000 | 78 | 78 | 1.000 | 126943.23 | 364642.3 | 370147.33 | 125763.58 | 1.0 | 1.36 | 1735 |
| lyn8 | 200 | 200 | 197 | 1.000 | 3.7 | 9.36 | 30.67 | 2.13 | 0.39 | 0.05 | 720 |
| lyn8 | 1000 | 1000 | 986 | 1.000 | 2.26 | 10.85 | 70.72 | 1.46 | 0.74 | 0.66 | 883 |
| lyn8 | 2000 | 83 | 82 | 1.000 | 119275.52 | 344719.36 | 350224.38 | 118161.41 | 1.14 | 1.38 | 1752 |
