import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

root = Path(__file__).resolve().parent.parent
out = Path(os.environ.get('RESULTS_DIR', '/tmp/lyn-perf-http/run-' + time.strftime('%Y%m%d-%H%M%S')))
out.mkdir(parents=True, exist_ok=True)
port = os.environ.get('BENCH_PORT', '14501')
env = os.environ | {'DATABASE_URL': os.environ.get('DATABASE_URL', 'postgresql://postgres@127.0.0.1:55432/lyn_timetrack'), 'BASE_URL': 'http://127.0.0.1:' + port, 'NODE_ENV': 'production', 'PORT': port}
app_cpus = os.environ.get('APP_CPUS', '0-3,24-27')
load_cpus = os.environ.get('LOAD_CPUS', '12-23,36-47')
pgpid = int(os.environ['PG_PID'])
owned = set()
failures = []

def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    owned.discard(proc)

def shutdown(signum, frame):
    for proc in list(owned):
        stop(proc)
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

def resources(done, app, label):
    with open(out / (label + '-resources.jsonl'), 'w', buffering=1) as stream:
        while not done.is_set():
            row = {'time': time.time(), 'load': os.getloadavg(), 'processes': {}}
            try:
                pids = [app.pid, pgpid] + [int(p) for p in Path(f'/proc/{pgpid}/task/{pgpid}/children').read_text().split()]
                pids += [p.pid for p in owned if p.pid != app.pid]
                for pid in pids:
                    try:
                        fields = Path(f'/proc/{pid}/stat').read_text().split()
                        row['processes'][pid] = {'ticks': int(fields[13]) + int(fields[14]), 'rss': int(fields[23]) * os.sysconf('SC_PAGE_SIZE'), 'comm': fields[1]}
                    except (FileNotFoundError, ProcessLookupError):
                        pass
            except (FileNotFoundError, ProcessLookupError):
                pass
            stream.write(json.dumps(row) + '\n')
            done.wait(1)

def driver(label, args, app, timeout=240):
    with open(out / (label + '.jsonl'), 'w') as log, open(out / (label + '-stderr.log'), 'w') as errors:
        proc = subprocess.Popen(['taskset', '-c', load_cpus, 'node', 'bench/http.mjs'] + args, cwd=root, env=env | {'SERVER_PID': str(app.pid), 'SAMPLES_FILE': str(out / (label + '-samples.json'))}, stdout=log, stderr=errors)
        owned.add(proc)
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            (out / (label + '-timeout.txt')).write_text('Driver exceeded timeout')
        finally:
            stop(proc)
    rows = [json.loads(line) for line in (out / (label + '.jsonl')).read_text().splitlines() if line.startswith('{')]
    if proc.returncode != 0 or not rows:
        failures.append(label + ': driver failed')
    for row in rows:
        if any(row.get(key) for key in ['errors', 'failures', 'unexpected', 'unsettled', 'staleFinal']):
            failures.append(label + ': correctness counter is nonzero')
    print(label, json.dumps(rows), 'exit', proc.returncode, flush=True)
    return rows

def run(label, args, profile=False):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', int(port)))
    print('START', label, time.time(), flush=True)
    with open(out / (label + '-server.log'), 'w') as log:
        cmd = ['taskset', '-c', app_cpus, 'node']
        if profile:
            cmd += ['--cpu-prof', '--cpu-prof-dir=' + str(out), '--cpu-prof-name=' + label + '.cpuprofile']
        cmd += ['../../packages/vite/src/cli.ts', 'start']
        app = subprocess.Popen(cmd, cwd=root / 'examples/timetrack', env=env, stdout=log, stderr=log)
        owned.add(app)
        done = threading.Event()
        monitor = threading.Thread(target=resources, args=(done, app, label))
        monitor.start()
        (out / 'active-server.pid').write_text(str(app.pid))
        try:
            for attempt in range(100):
                if app.poll() is not None:
                    raise RuntimeError('Server exited')
                try:
                    with urllib.request.urlopen(env['BASE_URL'] + '/', timeout=2) as response:
                        response.read()
                    break
                except OSError:
                    time.sleep(.1)
            driver(label + '-warm', ['http', '/week/2026-10-12', '1', '3'], app)
            return driver(label, args, app)
        finally:
            stop(app)
            done.set()
            monitor.join()
            time.sleep(1)

if __name__ == '__main__':
    manifest = {'startedAt': time.time(), 'appCpus': app_cpus, 'loadCpus': load_cpus, 'pgPid': pgpid, 'node': subprocess.check_output(['node', '-v'], text=True).strip(), 'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(), 'load': os.getloadavg(), 'clockTicks': os.sysconf('SC_CLK_TCK')}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    for path, name in [('/week/2026-10-12', 'week'), ('/', 'anonymous')]:
        for c in [1, 8, 32, 128]:
            run(f'http-{name}-{c}', ['http', path, str(c), '15'])
    for n in [1000, 5000, 10000]:
        run('capacity-' + str(n), ['capacity', str(n)])
    for n in [100, 1000, 10000]:
        for source in ['mutate', 'sql']:
            for rate in [1, 10, 25, 50, 100, 200]:
                rows = run(f'writes-{n}-{source}-{rate}', ['writes', str(n), source, str(rate), '10'])
                w = next((r for r in rows if r.get('mode') == 'writes'), None)
                if not w or w['errors'] or w['unsettled'] or w['staleFinal'] or (w['delivery']['p99'] or 0) > 1000 or w['missing'] > w['sent'] * w['expectedPerWrite'] * .05:
                    break
    for c in [1, 8, 32]:
        run('throughput-' + str(c), ['throughput', '128', str(c), '15'])
    run('profile-ssr', ['http', '/week/2026-10-12', '32', '25'], True)
    run('profile-writes', ['writes', '1000', 'mutate', '50', '25'], True)
    (out / 'complete.json').write_text(json.dumps({'finishedAt': time.time(), 'load': os.getloadavg(), 'failures': failures}))
    sys.exit(bool(failures))
