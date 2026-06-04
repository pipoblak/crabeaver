use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::auth::header_ok;
use crate::application::mcp as app;
use crate::domain::mcp::McpActivityEntry;
use crate::infrastructure::database::AppState;

/// Called once per tool invocation so the host can record + broadcast activity.
pub type ActivitySink = Arc<dyn Fn(McpActivityEntry) + Send + Sync>;

#[derive(Clone)]
struct Ctx {
    state: Arc<AppState>,
    token: String,
    sink: ActivitySink,
}

/// Tool JSON Schemas advertised by `tools/list`.
fn tool_schemas() -> Value {
    let conn = json!({ "type": "string", "description": "id of an exposed connection" });
    json!([
        { "name": "list_connections", "description": "List exposed database connections.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_databases", "description": "List databases on a connection.",
          "inputSchema": { "type": "object", "properties": { "connection_id": conn }, "required": ["connection_id"] } },
        { "name": "list_schemas", "description": "List schemas on a connection.",
          "inputSchema": { "type": "object", "properties": { "connection_id": conn, "database": {"type":"string"} }, "required": ["connection_id"] } },
        { "name": "describe_table", "description": "Columns, types, indexes and foreign keys of a table.",
          "inputSchema": { "type": "object", "properties": { "connection_id": conn, "schema": {"type":"string"}, "table": {"type":"string"} }, "required": ["connection_id","schema","table"] } },
        { "name": "run_query", "description": "Run SQL. Writes require the connection to allow writes.",
          "inputSchema": { "type": "object", "properties": { "connection_id": conn, "sql": {"type":"string"}, "limit": {"type":"integer"} }, "required": ["connection_id","sql"] } }
    ])
}

async fn call_tool(state: &AppState, name: &str, args: &Value) -> Result<Value, String> {
    let cid = || args.get("connection_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "list_connections" => Ok(serde_json::to_value(app::tool_list_connections(state).await).unwrap()),
        "list_databases" => Ok(serde_json::to_value(app::tool_list_databases(state, &cid()).await?).unwrap()),
        "list_schemas" => {
            let db = args.get("database").and_then(|v| v.as_str()).map(|s| s.to_string());
            app::tool_list_schemas(state, &cid(), db).await
        }
        "describe_table" => {
            let schema = args.get("schema").and_then(|v| v.as_str()).unwrap_or("");
            let table = args.get("table").and_then(|v| v.as_str()).unwrap_or("");
            app::tool_describe_table(state, &cid(), schema, table).await
        }
        "run_query" => {
            let sql = args.get("sql").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            Ok(serde_json::to_value(app::tool_run_query(state, &cid(), sql, limit).await?).unwrap())
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

async fn handle_post(State(ctx): State<Ctx>, headers: HeaderMap, Json(req): Json<Value>) -> impl IntoResponse {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok());
    if !header_ok(auth, &ctx.token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    if method == "notifications/initialized" {
        return StatusCode::ACCEPTED.into_response();
    }

    let result: Result<Value, String> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2025-03-26",
            "serverInfo": { "name": "crabeaver", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "tools": {} }
        })),
        "tools/list" => Ok(json!({ "tools": tool_schemas() })),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let connection = args.get("connection_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let outcome = call_tool(&ctx.state, name, &args).await;

            // Record activity (newest-last) and let the host broadcast it.
            let summary = match &outcome {
                Ok(v) => v.get("row_count").and_then(|n| n.as_u64())
                    .map(|n| format!("{n} rows"))
                    .unwrap_or_else(|| "ok".into()),
                Err(e) => format!("error: {e}"),
            };
            (ctx.sink)(McpActivityEntry {
                at: chrono::Utc::now().timestamp_millis(),
                tool: name.to_string(),
                connection,
                summary,
            });

            match outcome {
                Ok(v) => Ok(json!({ "content": [{ "type": "text", "text": v.to_string() }], "isError": false })),
                // Tool-level error: a tool result with isError, not a JSON-RPC error.
                Err(e) => Ok(json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
            }
        }
        _ => Err(format!("method not found: {method}")),
    };

    let body = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": e } }),
    };
    (StatusCode::OK, Json(body)).into_response()
}

/// Start the server on 127.0.0.1:port (port 0 = ephemeral). Returns the bound
/// port and a shutdown sender.
pub async fn start(
    state: Arc<AppState>,
    port: u16,
    token: String,
    sink: ActivitySink,
) -> Result<(u16, oneshot::Sender<()>), String> {
    let ctx = Ctx { state, token, sink };
    let router = Router::new()
        .route("/mcp", post(handle_post).get(|| async { StatusCode::METHOD_NOT_ALLOWED }))
        .with_state(ctx);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("port {port} unavailable: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok((bound, tx))
}
