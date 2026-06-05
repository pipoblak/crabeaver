//! Boots the MCP server on an ephemeral port and asserts auth behavior.
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use sqlx::sqlite::SqlitePoolOptions;
use tokio::sync::Mutex;

use crabeaver_lib::infrastructure::database::registry::DriverRegistry;
use crabeaver_lib::infrastructure::database::AppState;
use crabeaver_lib::infrastructure::mcp::server;

async fn test_state() -> AppState {
    // Single shared in-memory connection so migrations + later queries see one DB.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    AppState {
        db: pool,
        drivers: DriverRegistry::new(),
        biometric_cache: Arc::new(Mutex::new(HashMap::new())),
        biometric_lock: Arc::new(Mutex::new(())),
        schema_indices: Arc::new(RwLock::new(HashMap::new())),
        mcp_shutdown: Arc::new(Mutex::new(None)),
        mcp_activity: Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new())),
    }
}

#[tokio::test]
async fn missing_or_wrong_token_is_401_correct_is_200() {
    let state = Arc::new(test_state().await);
    let sink: server::ActivitySink = Arc::new(|_| {});
    let (port, _shutdown) = server::start(state, 0, "secret".into(), sink).await.unwrap();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "jsonrpc":"2.0","id":1,"method":"tools/list" });

    let no_auth = client.post(&url).json(&body).send().await.unwrap();
    assert_eq!(no_auth.status(), 401);

    let wrong = client.post(&url).bearer_auth("nope").json(&body).send().await.unwrap();
    assert_eq!(wrong.status(), 401);

    let ok = client.post(&url).bearer_auth("secret").json(&body).send().await.unwrap();
    assert_eq!(ok.status(), 200);
    let v: serde_json::Value = ok.json().await.unwrap();
    assert!(v["result"]["tools"].as_array().unwrap().len() == 5);
}

#[tokio::test]
async fn initialize_includes_global_prompt_as_instructions() {
    let state = test_state().await;
    crabeaver_lib::application::mcp::set_global_prompt(&state, "house rules").await;

    let sink: server::ActivitySink = Arc::new(|_| {});
    let (port, _shutdown) = server::start(Arc::new(state), 0, "secret".into(), sink).await.unwrap();
    let url = format!("http://127.0.0.1:{port}/mcp");

    let resp: serde_json::Value = reqwest::Client::new()
        .post(&url)
        .bearer_auth("secret")
        .json(&serde_json::json!({ "jsonrpc":"2.0","id":1,"method":"initialize","params":{} }))
        .send().await.unwrap()
        .json().await.unwrap();

    assert_eq!(resp["result"]["instructions"], serde_json::json!("house rules"));
}
