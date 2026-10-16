import json
from pathlib import Path
import sys

out = Path(sys.argv[1])
def read(name):
    return [json.loads(line) for line in (out / name).read_text().splitlines() if line.startswith('{')]
def triple(stats):
    return ' / '.join('—' if stats[key] is None else f'{stats[key]:.1f}' for key in ['p50', 'p95', 'p99'])
def table(headers, rows):
    print('| ' + ' | '.join(headers) + ' |')
    print('| ' + ' | '.join('---' for _ in headers) + ' |')
    for row in rows:
        print('| ' + ' | '.join(str(x) for x in row) + ' |')
    print()

print('All latency values are milliseconds. Results exclude warmup and profiled runs.\n')
rows = []
for route in ['week', 'anonymous']:
    for c in [1, 8, 32, 128]:
        r = read(f'http-{route}-{c}.jsonl')[0]
        rows.append([route, c, f"{r['rps']:.1f}", triple(r['latency']), f"{r['cpuMsPerRequest']:.2f}", sum(r['errors'].values())])
table(['Page', 'Concurrency', 'req/s', 'p50 / p95 / p99', 'App CPU ms/req', 'Errors'], rows)
rows = []
for n in [1000, 5000, 10000]:
    r = read(f'capacity-{n}.jsonl')[0]
    rows.append([n, f"{r['connectionsPerSec']:.1f}", triple(r['first']), triple(r['subscribe']), f"{r['rssAfter']/1048576:.1f}", f"{r['bytesPerConnection']/1024:.1f}", r['errors']])
table(['SSE clients', 'Connections ready/s', 'First data p50 / p95 / p99', 'Subscribe POST p50 / p95 / p99', 'App RSS MiB', 'Added KiB/client', 'Errors'], rows)
rows = []
for n in [100, 1000, 10000]:
    for source in ['mutate', 'sql']:
        for rate in [1, 10, 25, 50, 100, 200]:
            path = out / f'writes-{n}-{source}-{rate}.jsonl'
            if not path.exists():
                continue
            r = next((r for r in read(path.name) if r['mode'] == 'writes'), None)
            if r is None:
                rows.append([n, source, rate, 'TIMEOUT', '—', '—', '—', '—'])
                continue
            missing = 100 * r['missing'] / (r['sent'] * r['expectedPerWrite'])
            rows.append([n, source, rate, triple(r['delivery']), f"{r['delivery']['max']:.1f}" if r['delivery']['max'] else '—', f'{missing:.1f}%', f"{r['settled']['p99']:.1f}" if r['settled']['p99'] is not None else '—', r['staleFinal'], f"{r['unexpected']} / {r['errors']} / {r['unsettled']}"])
table(['Clients', 'Write path', 'Writes/s offered', 'Delivery p50 / p95 / p99', 'Max', 'Intermediate deliveries missing', 'Submitter settle p99', 'Stale final clients', 'Unexpected / errors / unsettled'], rows)
rows = []
for c in [1, 8, 32]:
    r = next(r for r in read(f'throughput-{c}.jsonl') if r['mode'] == 'throughput')
    rows.append([c, f"{r['rps']:.1f}", triple(r['http']), triple(r['settled']), f"{r['cpuMsPerMutation']:.2f}", r['failures']])
table(['Concurrent writers', 'Settled mutations/s', 'HTTP p50 / p95 / p99', 'Settled p50 / p95 / p99', 'App CPU ms/mutation', 'Errors'], rows)
