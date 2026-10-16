import json
import sys
from collections import defaultdict

prefix, mix, groups_text = sys.argv[1:]
groups = int(groups_text)
writes = json.load(open(prefix + '-writes.json'))['events']
deliveries = json.load(open(prefix + '-delivery.json'))
by_sub = defaultdict(list)
for delivery in deliveries:
    snapshot = delivery.get('snapshot')
    if snapshot:
        xmin, xmax, xip = snapshot.split(':')
        by_sub[delivery['sub']].append((delivery['time'], int(xmax), set(map(int, filter(None, xip.split(','))))))

def summary(values):
    values.sort()
    return dict(count=len(values), **{key: values[min(len(values)-1, int(len(values)*fraction))] if values else None for key, fraction in [('p50', .5), ('p95', .95), ('p99', .99), ('max', 1)]})

latencies = []
lasts = []
missing = 0
for event in writes:
    xid = int(event['xid'])
    bucket = event['seq'] % ((groups + 2)//3)
    affected = range(bucket*3, min(groups, bucket*3+3)) if mix == 'precise' else range(groups)
    last = 0
    complete = True
    for sub in affected:
        entries = by_sub[sub]
        low, high = 0, len(entries)
        while low < high:
            mid = (low + high)//2
            time, xmax, xip = entries[mid]
            if xid < xmax and xid not in xip:
                high = mid
            else:
                low = mid + 1
        if low == len(entries):
            missing += 1
            complete = False
        else:
            latency = entries[low][0] - event['commit']
            latencies.append(latency)
            last = max(last, latency)
    if complete:
        lasts.append(last)
print(json.dumps(dict(prefix=prefix, mix=mix, groups=groups, missing=missing, per_group_ms=summary(latencies), all_groups_ms=summary(lasts))))
