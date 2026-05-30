//! OS keychain / secret-store adapter. Engine-agnostic: every driver stores its
//! connection password here, keyed by connection id. Passwords never live in the
//! app's SQLite database and are never returned to the frontend.
//!
//! - macOS: the `security` CLI (legacy `SecKeychainAddGenericPassword` semantics)
//!   so items are not code-signature bound — avoids the "Allow access?" dialog
//!   that would otherwise fire on every dev rebuild.
//! - Other platforms: the `keyring` crate (Windows Credential Manager, libsecret …).

const SERVICE: &str = "crabeaver";

// ── macOS: `security` CLI ────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub fn store_password(id: &str, password: &str) -> Result<(), String> {
    // Delete existing entry (ignore errors)
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", id])
        .output();
    let out = std::process::Command::new("security")
        .args(["add-generic-password", "-s", SERVICE, "-a", id, "-w", password])
        .output()
        .map_err(|e| format!("security CLI error: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
pub fn load_password(id: &str) -> Result<String, String> {
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", id, "-w"])
        .output()
        .map_err(|e| format!("security CLI error: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err("Password not found. Open Settings → Connections and re-enter the password.".into())
    }
}

#[cfg(target_os = "macos")]
pub fn delete_password(id: &str) {
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", id])
        .output();
}

// ── Other platforms: `keyring` crate ─────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub fn store_password(id: &str, password: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, id)
        .and_then(|e| e.set_password(password))
        .map_err(|e| format!("Keychain write failed: {e}"))
}

#[cfg(not(target_os = "macos"))]
pub fn load_password(id: &str) -> Result<String, String> {
    keyring::Entry::new(SERVICE, id)
        .and_then(|e| e.get_password())
        .map_err(|e| match e {
            keyring::Error::NoEntry => {
                "Password not found. Open Settings → Connections and re-enter the password.".to_string()
            }
            _ => format!("Keychain read failed: {e}"),
        })
}

#[cfg(not(target_os = "macos"))]
pub fn delete_password(id: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, id) {
        let _ = e.delete_credential();
    }
}
