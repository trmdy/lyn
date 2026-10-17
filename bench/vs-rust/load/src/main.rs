use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hdrhistogram::Histogram;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

const SHARDS: usize = 64;

#[derive(Clone)]
struct Args {
    mode: String,
    target: String,
    addr: String,
    clients: usize,
    groups: usize,
    rows: usize,
    rate: f64,
    seconds: f64,
    concurrency: usize,
    writers: usize,
    path: String,
    server_pid: u32,
    pg_pid: u32,
    run: u32,
}

fn parse_args() -> Args {
    let mut values: HashMap<String, String> = HashMap::new();
    let raw: Vec<String> = std::env::args().skip(1).collect();
    for pair in raw.chunks(2) {
        values.insert(pair[0].trim_start_matches("--").to_string(), pair.get(1).cloned().unwrap_or_default());
    }
    let get = |key: &str, default: &str| values.get(key).cloned().unwrap_or_else(|| default.to_string());
    let clients: usize = get("clients", "1000").parse().unwrap();
    Args {
        mode: get("mode", "shared"),
        target: get("target", "rust"),
        addr: get("addr", "127.0.0.1:4600"),
        clients,
        groups: get("groups", &clients.to_string()).parse().unwrap(),
        rows: get("rows", "20").parse().unwrap(),
        rate: get("rate", "100").parse().unwrap(),
        seconds: get("seconds", "20").parse().unwrap(),
        concurrency: get("concurrency", "128").parse().unwrap(),
        writers: get("writers", "128").parse().unwrap(),
        path: get("path", "/api/items"),
        server_pid: get("server-pid", "0").parse().unwrap(),
        pg_pid: get("pg-pid", "0").parse().unwrap(),
        run: std::process::id() ^ (Instant::now().elapsed().subsec_nanos()),
    }
}

struct Http {
    reader: BufReader<TcpStream>,
}

struct Head {
    status: u16,
    length: Option<usize>,
    chunked: bool,
}

impl Http {
    async fn connect(addr: &str) -> io::Result<Http> {
        let stream = TcpStream::connect(addr).await?;
        stream.set_nodelay(true)?;
        Ok(Http { reader: BufReader::with_capacity(64 * 1024, stream) })
    }

    async fn send(&mut self, method: &str, path: &str, content_type: &str, body: &[u8]) -> io::Result<()> {
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: bench\r\nAccept: */*\r\n");
        if !body.is_empty() || method == "POST" {
            request.push_str(&format!("Content-Type: {content_type}\r\nContent-Length: {}\r\n", body.len()));
        }
        request.push_str("\r\n");
        let stream = self.reader.get_mut();
        stream.write_all(request.as_bytes()).await?;
        if !body.is_empty() {
            stream.write_all(body).await?;
        }
        Ok(())
    }

    async fn head(&mut self) -> io::Result<Head> {
        let mut line = String::new();
        self.reader.read_line(&mut line).await?;
        let status = line.split_whitespace().nth(1).and_then(|code| code.parse().ok()).ok_or_else(|| io::Error::other(format!("bad status line {line:?}")))?;
        let mut head = Head { status, length: None, chunked: false };
        loop {
            line.clear();
            if self.reader.read_line(&mut line).await? == 0 {
                return Err(io::Error::other("eof in headers"));
            }
            let header = line.trim_end();
            if header.is_empty() {
                return Ok(head);
            }
            let lower = header.to_ascii_lowercase();
            if let Some(value) = lower.strip_prefix("content-length:") {
                head.length = value.trim().parse().ok();
            } else if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
                head.chunked = true;
            }
        }
    }

    async fn chunk(&mut self) -> io::Result<Option<Vec<u8>>> {
        let mut line = String::new();
        if self.reader.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("0"), 16).map_err(|_| io::Error::other(format!("bad chunk size {line:?}")))?;
        if size == 0 {
            line.clear();
            self.reader.read_line(&mut line).await?;
            return Ok(None);
        }
        let mut data = vec![0u8; size + 2];
        self.reader.read_exact(&mut data).await?;
        data.truncate(size);
        Ok(Some(data))
    }

    async fn body(&mut self, head: &Head) -> io::Result<Vec<u8>> {
        if head.chunked {
            let mut body = Vec::new();
            while let Some(chunk) = self.chunk().await? {
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        } else {
            let mut body = vec![0u8; head.length.unwrap_or(0)];
            self.reader.read_exact(&mut body).await?;
            Ok(body)
        }
    }

    async fn request(&mut self, method: &str, path: &str, content_type: &str, body: &[u8]) -> io::Result<(u16, Vec<u8>)> {
        self.send(method, path, content_type, body).await?;
        let head = self.head().await?;
        let body = self.body(&head).await?;
        Ok((head.status, body))
    }
}

struct Shared {
    args: Args,
    start: Instant,
    sent: Vec<AtomicU64>,
    deliveries: AtomicU64,
    ready: AtomicU64,
    failed: AtomicU64,
    delivery: Vec<Mutex<Histogram<u64>>>,
    write_latency: Mutex<Histogram<u64>>,
    writes_ok: AtomicU64,
    writes_failed: AtomicU64,
}

impl Shared {
    fn now_ns(&self) -> u64 {
        self.start.elapsed().as_nanos() as u64
    }
}

fn histogram() -> Histogram<u64> {
    Histogram::new_with_bounds(1, 600_000_000, 3).unwrap()
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&index| &haystack[index..index + needle.len()] == needle)
}

fn markers(event: &[u8], prefix: &[u8]) -> Vec<u64> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(index) = find(event, prefix, at) {
        let mut cursor = index + prefix.len();
        let mut value = 0u64;
        let digits = cursor;
        while cursor < event.len() && event[cursor].is_ascii_digit() {
            value = value * 10 + (event[cursor] - b'0') as u64;
            cursor += 1;
        }
        if cursor > digits && event.get(cursor) == Some(&b'x') {
            found.push(value);
        }
        at = cursor.max(index + 1);
    }
    found
}

fn lyn_subscribe_body(client_id: &str, grp: usize) -> String {
    format!(r#"[{{"clientId":1,"add":2,"remove":8}},"{client_id}",[3],{{"sub":4,"name":5,"args":6}},1,"vs:items",{{"grp":7}},{grp},[]]"#)
}

fn lyn_mutate_body(mutation_id: &str, id: usize, label: &str) -> String {
    format!(r#"[{{"mutationId":1,"name":2,"args":3}},"{mutation_id}","vs:rename",{{"id":4,"label":5}},{id},"{label}"]"#)
}

fn client_group(args: &Args, index: usize) -> usize {
    if args.mode == "shared" {
        1
    } else {
        index % args.groups + 1
    }
}

async fn sse_client(index: usize, shared: Arc<Shared>) -> io::Result<()> {
    let args = &shared.args;
    let grp = client_group(args, index);
    let lyn = args.target == "lyn";
    let mut http = Http::connect(&args.addr).await?;
    let path = if lyn { "/_lyn/events".to_string() } else { format!("/events?grp={grp}") };
    http.send("GET", &path, "", &[]).await?;
    let head = http.head().await?;
    if head.status != 200 {
        return Err(io::Error::other(format!("events status {}", head.status)));
    }
    let prefix = format!("\"r{}w", args.run).into_bytes();
    let shard = &shared.delivery[index % SHARDS];
    let mut buffer: Vec<u8> = Vec::new();
    let mut ready = false;
    let mut max_seen = 0u64;
    while let Some(chunk) = http.chunk().await? {
        buffer.extend_from_slice(&chunk);
        while let Some(end) = find(&buffer, b"\n\n", 0) {
            let event: Vec<u8> = buffer.drain(..end + 2).collect();
            if lyn && find(&event, b"event: hello", 0).is_some() {
                let data = event.split(|&byte| byte == b'\n').find(|line| line.starts_with(b"data: ")).unwrap_or(b"");
                let hello: serde_json::Value = serde_json::from_slice(&data[6..]).map_err(io::Error::other)?;
                let client_id = hello["clientId"].as_str().unwrap_or_default().to_string();
                let mut control = Http::connect(&args.addr).await?;
                let (status, body) = control.request("POST", "/_lyn/subscribe", "application/x-devalue", lyn_subscribe_body(&client_id, grp).as_bytes()).await?;
                if status != 200 {
                    return Err(io::Error::other(format!("subscribe status {status}: {}", String::from_utf8_lossy(&body))));
                }
                continue;
            }
            if find(&event, b"event: frame", 0).is_none() {
                continue;
            }
            if !ready {
                ready = true;
                shared.ready.fetch_add(1, Ordering::Relaxed);
            }
            let found = markers(&event, &prefix);
            if found.is_empty() {
                continue;
            }
            let now = shared.now_ns();
            let mut histogram = None;
            for seq in found.iter().copied().filter(|&seq| seq > max_seen) {
                let sent = shared.sent.get(seq as usize).map(|cell| cell.load(Ordering::Relaxed)).unwrap_or(0);
                if sent == 0 {
                    continue;
                }
                let histogram = histogram.get_or_insert_with(|| shard.lock().unwrap());
                let _ = histogram.record(now.saturating_sub(sent).max(1000) / 1000);
                shared.deliveries.fetch_add(1, Ordering::Relaxed);
            }
            max_seen = max_seen.max(found.into_iter().max().unwrap_or(0));
        }
    }
    Ok(())
}

fn mix(mut value: u64) -> u64 {
    value ^= value >> 33;
    value = value.wrapping_mul(0xff51afd7ed558ccd);
    value ^= value >> 33;
    value
}

async fn writer(shared: Arc<Shared>, next: Arc<AtomicU64>, total: u64, origin: Instant) -> io::Result<()> {
    let args = &shared.args;
    let mut http = Http::connect(&args.addr).await?;
    loop {
        let seq = next.fetch_add(1, Ordering::Relaxed) + 1;
        if seq > total {
            return Ok(());
        }
        let due = origin + Duration::from_secs_f64((seq - 1) as f64 / args.rate);
        tokio::time::sleep_until(due.into()).await;
        let grp = if args.mode == "shared" { 1 } else { (mix(seq) % args.groups as u64) as usize + 1 };
        let id = (grp - 1) * args.rows + (seq as usize % args.rows) + 1;
        let label = format!("r{}w{}x", args.run, seq);
        let scheduled = (due - shared.start).as_nanos() as u64;
        shared.sent[seq as usize].store(scheduled.max(1), Ordering::Relaxed);
        let result = if args.target == "lyn" {
            http.request("POST", "/_lyn/mutate", "application/x-devalue", lyn_mutate_body(&format!("m{}-{seq}", args.run), id, &label).as_bytes()).await
        } else {
            http.request("POST", "/mutate", "application/json", format!(r#"{{"id":{id},"label":"{label}"}}"#).as_bytes()).await
        };
        match result {
            Ok((200, _)) => {
                shared.writes_ok.fetch_add(1, Ordering::Relaxed);
                let _ = shared.write_latency.lock().unwrap().record(shared.now_ns().saturating_sub(scheduled).max(1000) / 1000);
            }
            Ok((status, body)) => {
                if shared.writes_failed.fetch_add(1, Ordering::Relaxed) < 3 {
                    eprintln!("write failed {status}: {}", String::from_utf8_lossy(&body));
                }
            }
            Err(error) => {
                shared.writes_failed.fetch_add(1, Ordering::Relaxed);
                eprintln!("write error: {error}");
                http = Http::connect(&args.addr).await?;
            }
        }
    }
}

fn cpu_ticks(pid: u32) -> Option<(u64, u32)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<&str> = stat[stat.rfind(')')? + 2..].split_whitespace().collect();
    Some((fields[11].parse::<u64>().ok()? + fields[12].parse::<u64>().ok()?, fields[1].parse().ok()?))
}

fn tree_ticks(root: u32) -> u64 {
    if root == 0 {
        return 0;
    }
    let mut total = 0;
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
        if let Some((ticks, parent)) = cpu_ticks(pid) {
            if pid == root || parent == root {
                total += ticks;
            }
        }
    }
    total
}

fn rss_mb(pid: u32) -> f64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|status| status.lines().find(|line| line.starts_with("VmRSS:")).and_then(|line| line.split_whitespace().nth(1)?.parse::<f64>().ok()))
        .map(|kb| kb / 1024.0)
        .unwrap_or(0.0)
}

fn quantiles(histogram: &Histogram<u64>) -> serde_json::Value {
    let ms = |q: f64| (histogram.value_at_quantile(q) as f64 / 1000.0 * 100.0).round() / 100.0;
    serde_json::json!({ "p50": ms(0.5), "p90": ms(0.9), "p99": ms(0.99), "max": (histogram.max() as f64 / 10.0).round() / 100.0, "count": histogram.len() })
}

struct Usage {
    server: u64,
    postgres: u64,
    at: Instant,
}

fn usage(args: &Args) -> Usage {
    Usage { server: tree_ticks(args.server_pid), postgres: tree_ticks(args.pg_pid), at: Instant::now() }
}

fn usage_json(before: &Usage, after: &Usage) -> serde_json::Value {
    let seconds = after.at.duration_since(before.at).as_secs_f64();
    serde_json::json!({
        "serverCores": ((after.server - before.server) as f64 / 100.0 / seconds * 100.0).round() / 100.0,
        "postgresCores": ((after.postgres - before.postgres) as f64 / 100.0 / seconds * 100.0).round() / 100.0,
    })
}

async fn live(args: Args) -> serde_json::Value {
    let total = (args.rate * args.seconds).round() as u64;
    let shared = Arc::new(Shared {
        args: args.clone(),
        start: Instant::now(),
        sent: (0..=total as usize + 1).map(|_| AtomicU64::new(0)).collect(),
        deliveries: AtomicU64::new(0),
        ready: AtomicU64::new(0),
        failed: AtomicU64::new(0),
        delivery: (0..SHARDS).map(|_| Mutex::new(histogram())).collect(),
        write_latency: Mutex::new(histogram()),
        writes_ok: AtomicU64::new(0),
        writes_failed: AtomicU64::new(0),
    });
    let connect_start = Instant::now();
    for batch in (0..args.clients).collect::<Vec<_>>().chunks(500) {
        for &index in batch {
            let shared = shared.clone();
            tokio::spawn(async move {
                if let Err(error) = sse_client(index, shared.clone()).await {
                    if shared.failed.fetch_add(1, Ordering::Relaxed) < 3 {
                        eprintln!("client {index}: {error}");
                    }
                }
            });
        }
        let target = (batch.last().unwrap() + 1) as u64;
        let wait = Instant::now();
        while shared.ready.load(Ordering::Relaxed) + shared.failed.load(Ordering::Relaxed) < target && wait.elapsed() < Duration::from_secs(60) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    let ready_seconds = connect_start.elapsed().as_secs_f64();
    let rss_before = rss_mb(args.server_pid);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = usage(&args);
    let origin = Instant::now() + Duration::from_millis(50);
    let next = Arc::new(AtomicU64::new(0));
    let writers: Vec<_> = (0..args.writers).map(|_| tokio::spawn(writer(shared.clone(), next.clone(), total, origin))).collect();
    for handle in writers {
        let _ = handle.await;
    }
    let writes_done = Instant::now();
    let mut last = shared.deliveries.load(Ordering::Relaxed);
    let mut quiet = Instant::now();
    while quiet.elapsed() < Duration::from_secs(2) && writes_done.elapsed() < Duration::from_secs(30) {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let current = shared.deliveries.load(Ordering::Relaxed);
        if current != last {
            last = current;
            quiet = Instant::now();
        }
    }
    let after = usage(&args);
    let mut delivery = histogram();
    for shard in &shared.delivery {
        delivery.add(&*shard.lock().unwrap()).unwrap();
    }
    let writes_ok = shared.writes_ok.load(Ordering::Relaxed);
    let per_write = if args.mode == "shared" { args.clients } else { args.clients / args.groups };
    let expected = writes_ok * per_write as u64;
    let elapsed = origin.elapsed().as_secs_f64() - 2.0;
    serde_json::json!({
        "mode": args.mode, "target": args.target, "clients": args.clients, "groups": if args.mode == "shared" { 1 } else { args.groups },
        "rate": args.rate, "seconds": args.seconds,
        "readyClients": shared.ready.load(Ordering::Relaxed), "failedClients": shared.failed.load(Ordering::Relaxed), "readySeconds": (ready_seconds * 100.0).round() / 100.0,
        "writesOk": writes_ok, "writesFailed": shared.writes_failed.load(Ordering::Relaxed),
        "achievedWritesPerSecond": (writes_ok as f64 / writes_done.duration_since(origin).as_secs_f64()).round(),
        "writeMs": quantiles(&shared.write_latency.lock().unwrap()),
        "deliveryMs": quantiles(&delivery),
        "delivered": shared.deliveries.load(Ordering::Relaxed), "expected": expected,
        "deliveredShare": ((shared.deliveries.load(Ordering::Relaxed) as f64 / expected.max(1) as f64) * 1000.0).round() / 1000.0,
        "deliveriesPerSecond": (shared.deliveries.load(Ordering::Relaxed) as f64 / elapsed.max(0.001)).round(),
        "usage": usage_json(&before, &after),
        "serverRssMb": { "afterConnect": rss_before.round(), "end": rss_mb(args.server_pid).round() },
    })
}

async fn http_load(args: Args) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs_f64(args.seconds);
    let latency = Arc::new(Mutex::new(histogram()));
    let errors = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let warmup = Instant::now() + Duration::from_secs(2);
    let tasks: Vec<_> = (0..args.concurrency)
        .map(|task| {
            let (args, latency, errors, bytes) = (args.clone(), latency.clone(), errors.clone(), bytes.clone());
            tokio::spawn(async move {
                let mut local = histogram();
                let mut http = Http::connect(&args.addr).await.expect("connect");
                let mut seq = task as u64 * 1_000_003;
                while Instant::now() < deadline {
                    seq += 1;
                    let grp = (mix(seq) % args.groups as u64) as usize + 1;
                    let started = Instant::now();
                    match http.request("GET", &format!("{}?grp={grp}", args.path), "", &[]).await {
                        Ok((200, body)) if !body.is_empty() => {
                            if started >= warmup {
                                let _ = local.record(started.elapsed().as_micros().max(1) as u64);
                                bytes.fetch_add(body.len() as u64, Ordering::Relaxed);
                            }
                        }
                        Ok(_) => {
                            errors.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(_) => {
                            errors.fetch_add(1, Ordering::Relaxed);
                            http = Http::connect(&args.addr).await.expect("reconnect");
                        }
                    }
                }
                latency.lock().unwrap().add(&local).unwrap();
            })
        })
        .collect();
    tokio::time::sleep_until(warmup.into()).await;
    let before = usage(&args);
    for task in tasks {
        let _ = task.await;
    }
    let after = usage(&args);
    let latency = latency.lock().unwrap();
    let seconds = after.at.duration_since(before.at).as_secs_f64();
    serde_json::json!({
        "mode": "http", "target": args.target, "path": args.path, "concurrency": args.concurrency, "seconds": args.seconds,
        "requestsPerSecond": (latency.len() as f64 / seconds).round(),
        "latencyMs": quantiles(&latency),
        "errors": errors.load(Ordering::Relaxed),
        "avgBodyBytes": bytes.load(Ordering::Relaxed) / latency.len().max(1),
        "usage": usage_json(&before, &after),
        "serverRssMb": rss_mb(args.server_pid).round(),
    })
}

fn main() {
    let args = parse_args();
    let workers: usize = std::env::var("WORKERS").ok().and_then(|value| value.parse().ok()).unwrap_or(16);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(workers).enable_all().build().unwrap();
    let result = runtime.block_on(async move {
        if args.mode == "http" {
            http_load(args).await
        } else {
            live(args).await
        }
    });
    println!("{result}");
    std::process::exit(0);
}
