use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use futures::StreamExt;
use postgres_replication::protocol::{LogicalReplicationMessage, ReplicationMessage, Tuple, TupleData};
use postgres_replication::LogicalReplicationStream;
use postgres_types::PgLsn;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::sync::Semaphore;
use tokio_postgres::config::ReplicationMode;
use tokio_postgres::{Client, Config, NoTls, Statement};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const ROWS_SQL: &str = "select id, label, val from items where grp = $1 order by id";
const RENAME_SQL: &str = "update items set label = $2 where id = $1";
const SUBSCRIBER_BUFFER: usize = 256;

struct Connection {
    client: Client,
    rows: Statement,
    rename: Statement,
}

struct Db {
    connections: Vec<Connection>,
    next: AtomicUsize,
}

#[derive(Serialize)]
struct Row {
    id: i32,
    label: String,
    val: i32,
}

impl Db {
    async fn open(url: &str, count: usize) -> Db {
        let mut connections = Vec::with_capacity(count);
        for _ in 0..count {
            let (client, connection) = tokio_postgres::connect(url, NoTls).await.expect("connect");
            tokio::spawn(async move {
                if let Err(error) = connection.await {
                    eprintln!("[rust] connection error: {error}");
                }
            });
            let rows = client.prepare(ROWS_SQL).await.expect("prepare rows");
            let rename = client.prepare(RENAME_SQL).await.expect("prepare rename");
            connections.push(Connection { client, rows, rename });
        }
        Db { connections, next: AtomicUsize::new(0) }
    }

    fn pick(&self) -> &Connection {
        &self.connections[self.next.fetch_add(1, Ordering::Relaxed) % self.connections.len()]
    }

    async fn rows(&self, grp: i32) -> Result<Vec<Row>, tokio_postgres::Error> {
        let connection = self.pick();
        let rows = connection.client.query(&connection.rows, &[&grp]).await?;
        Ok(rows.iter().map(|row| Row { id: row.get(0), label: row.get(1), val: row.get(2) }).collect())
    }

    async fn rename(&self, id: i32, label: &str) -> Result<u64, tokio_postgres::Error> {
        let connection = self.pick();
        connection.client.execute(&connection.rename, &[&id, &label]).await
    }
}

#[derive(Default)]
struct GroupState {
    running: bool,
    dirty: bool,
    last: Option<Bytes>,
}

#[derive(Default)]
struct Group {
    subscribers: Mutex<Vec<mpsc::Sender<Bytes>>>,
    state: Mutex<GroupState>,
}

struct App {
    db: Db,
    groups: Mutex<HashMap<i32, Arc<Group>>>,
    runs: Semaphore,
}

#[derive(Serialize)]
struct Frame<'a> {
    group: i32,
    rows: &'a [Row],
}

fn sse_frame(grp: i32, rows: &[Row]) -> Bytes {
    let mut out = Vec::with_capacity(64 + rows.len() * 48);
    out.extend_from_slice(b"event: frame\ndata: ");
    serde_json::to_writer(&mut out, &Frame { group: grp, rows }).expect("json");
    out.extend_from_slice(b"\n\n");
    Bytes::from(out)
}

fn schedule(app: &Arc<App>, grp: i32, group: &Arc<Group>) {
    {
        let mut state = group.state.lock().unwrap();
        if state.running {
            state.dirty = true;
            return;
        }
        state.running = true;
        state.dirty = false;
    }
    let app = app.clone();
    let group = group.clone();
    tokio::spawn(async move {
        loop {
            let result = {
                let _permit = app.runs.acquire().await.expect("semaphore");
                app.db.rows(grp).await
            };
            match result {
                Ok(rows) => {
                    let frame = sse_frame(grp, &rows);
                    let changed = {
                        let mut state = group.state.lock().unwrap();
                        let changed = state.last.as_ref() != Some(&frame);
                        state.last = Some(frame.clone());
                        changed
                    };
                    if changed {
                        group.subscribers.lock().unwrap().retain(|subscriber| match subscriber.try_send(frame.clone()) {
                            Ok(()) => true,
                            Err(TrySendError::Full(_)) | Err(TrySendError::Closed(_)) => false,
                        });
                    }
                }
                Err(error) => eprintln!("[rust] query failed for group {grp}: {error}"),
            }
            let mut state = group.state.lock().unwrap();
            if state.dirty {
                state.dirty = false;
                continue;
            }
            state.running = false;
            break;
        }
    });
}

#[derive(Deserialize)]
struct GroupQuery {
    grp: i32,
}

async fn events(State(app): State<Arc<App>>, Query(query): Query<GroupQuery>) -> Response {
    let (sender, receiver) = mpsc::channel::<Bytes>(SUBSCRIBER_BUFFER);
    let (group, created) = {
        let mut groups = app.groups.lock().unwrap();
        match groups.get(&query.grp) {
            Some(group) => (group.clone(), false),
            None => {
                let group = Arc::new(Group::default());
                groups.insert(query.grp, group.clone());
                (group, true)
            }
        }
    };
    {
        let mut subscribers = group.subscribers.lock().unwrap();
        if let Some(last) = group.state.lock().unwrap().last.clone() {
            let _ = sender.try_send(last);
        }
        subscribers.push(sender);
    }
    if created {
        schedule(&app, query.grp, &group);
    }
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|bytes| (Ok::<_, Infallible>(bytes), receiver))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap()
}

#[derive(Deserialize)]
struct Rename {
    id: i32,
    label: String,
}

async fn mutate(State(app): State<Arc<App>>, Json(rename): Json<Rename>) -> Response {
    match app.db.rename(rename.id, &rename.label).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

async fn items(State(app): State<Arc<App>>, Query(query): Query<GroupQuery>) -> Response {
    match app.db.rows(query.grp).await {
        Ok(rows) => Json(rows).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

fn escape_into(out: &mut String, text: &str) {
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            other => out.push(other),
        }
    }
}

async fn page(State(app): State<Arc<App>>, Query(query): Query<GroupQuery>) -> Response {
    let rows = match app.db.rows(query.grp).await {
        Ok(rows) => rows,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    };
    let mut html = String::with_capacity(4096);
    html.push_str("<!doctype html><html><head><meta charset=\"utf-8\"><title>Items</title></head><body><div id=\"root\"><main><h1>Group ");
    let _ = write!(html, "{}</h1><ul>", query.grp);
    for row in &rows {
        let _ = write!(html, "<li data-id=\"{}\"><span>", row.id);
        escape_into(&mut html, &row.label);
        let _ = write!(html, "</span> <b>{}</b></li>", row.val);
    }
    html.push_str("</ul></main></div><script>window.__DATA__=");
    html.push_str(&serde_json::to_string(&rows).expect("json").replace('<', "\\u003c"));
    html.push_str("</script><script type=\"module\" src=\"/assets/app.js\"></script></body></html>");
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}

fn group_of(tuple: &Tuple, column: usize) -> Option<i32> {
    match tuple.tuple_data().get(column)? {
        TupleData::Text(bytes) => std::str::from_utf8(bytes).ok()?.parse().ok(),
        _ => None,
    }
}

fn touch(rel: u32, tuple: Option<&Tuple>, touched: &mut HashSet<i32>, columns: &HashMap<u32, usize>) {
    if let (Some(&column), Some(tuple)) = (columns.get(&rel), tuple) {
        if let Some(grp) = group_of(tuple, column) {
            touched.insert(grp);
        }
    }
}

fn postgres_now() -> i64 {
    let unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as i64;
    unix - 946_684_800_000_000
}

async fn replicate(app: Arc<App>, url: String) {
    let mut config: Config = url.parse().expect("database url");
    config.replication_mode(ReplicationMode::Logical);
    let (client, connection) = config.connect(NoTls).await.expect("replication connect");
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("[rust] replication connection error: {error}");
        }
    });
    let slot = format!("vs_rust_{}", std::process::id());
    client
        .simple_query(&format!("CREATE_REPLICATION_SLOT {slot} TEMPORARY LOGICAL pgoutput NOEXPORT_SNAPSHOT"))
        .await
        .expect("create slot");
    let start = format!("START_REPLICATION SLOT {slot} LOGICAL 0/0 (\"proto_version\" '1', \"publication_names\" 'vs_pub')");
    let duplex = client.copy_both_simple::<Bytes>(&start).await.expect("start replication");
    let stream = LogicalReplicationStream::new(duplex);
    tokio::pin!(stream);
    let mut group_columns: HashMap<u32, usize> = HashMap::new();
    let mut touched: HashSet<i32> = HashSet::new();
    let mut position = 0u64;
    while let Some(message) = stream.next().await {
        match message.expect("replication stream") {
            ReplicationMessage::XLogData(body) => {
                position = position.max(body.wal_end());
                match body.into_data() {
                    LogicalReplicationMessage::Relation(relation) => {
                        if let Some(index) = relation.columns().iter().position(|column| column.name().ok() == Some("grp")) {
                            group_columns.insert(relation.rel_id(), index);
                        }
                    }
                    LogicalReplicationMessage::Insert(insert) => touch(insert.rel_id(), Some(insert.tuple()), &mut touched, &group_columns),
                    LogicalReplicationMessage::Update(update) => {
                        touch(update.rel_id(), Some(update.new_tuple()), &mut touched, &group_columns);
                        touch(update.rel_id(), update.old_tuple(), &mut touched, &group_columns);
                    }
                    LogicalReplicationMessage::Delete(delete) => {
                        touch(delete.rel_id(), delete.old_tuple(), &mut touched, &group_columns);
                    }
                    LogicalReplicationMessage::Commit(_) => {
                        let affected: Vec<(i32, Arc<Group>)> = {
                            let groups = app.groups.lock().unwrap();
                            touched.drain().filter_map(|grp| groups.get(&grp).map(|group| (grp, group.clone()))).collect()
                        };
                        for (grp, group) in affected {
                            schedule(&app, grp, &group);
                        }
                    }
                    _ => {}
                }
            }
            ReplicationMessage::PrimaryKeepAlive(keepalive) => {
                position = position.max(keepalive.wal_end());
                if keepalive.reply() == 1 {
                    let lsn = PgLsn::from(position);
                    stream.as_mut().standby_status_update(lsn, lsn, lsn, postgres_now(), 0).await.expect("status update");
                }
            }
            _ => {}
        }
    }
}

fn main() {
    let workers: usize = std::env::var("WORKERS").ok().and_then(|value| value.parse().ok()).unwrap_or(1);
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(run());
}

async fn run() {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let port: u16 = std::env::var("PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(4600);
    let connections: usize = std::env::var("CONNECTIONS").ok().and_then(|value| value.parse().ok()).unwrap_or(16);
    let app = Arc::new(App {
        db: Db::open(&url, connections).await,
        groups: Mutex::new(HashMap::new()),
        runs: Semaphore::new(connections * 4),
    });
    tokio::spawn(replicate(app.clone(), url));
    let router = Router::new()
        .route("/events", get(events))
        .route("/mutate", post(mutate))
        .route("/api/items", get(items))
        .route("/page", get(page))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    eprintln!("[rust] listening on 127.0.0.1:{port}");
    axum::serve(listener, router).await.expect("serve");
}
