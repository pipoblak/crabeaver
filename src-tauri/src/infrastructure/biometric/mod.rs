//! Biometric authentication adapter.
//! - macOS: compiles a tiny Swift `LocalAuthentication` helper once, caches it,
//!   runs it. The compiled binary is named "Crabeaver Auth" so the Touch ID
//!   dialog shows that instead of "swift-frontend".
//! - Other platforms: no-op (always available=false, authenticate=Ok).
//!
//! Engine-agnostic: gating a *connection* behind Touch ID is independent of which
//! database engine it speaks to.

/// Whether biometric auth can be performed on this device.
pub fn available() -> bool {
    #[cfg(target_os = "macos")]
    return macos::available();
    #[cfg(not(target_os = "macos"))]
    false
}

/// Prompt for biometric auth. Blocks until the user responds. `Ok(())` on success.
pub fn authenticate(reason: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::authenticate(reason);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Ok(())
    }
}

/// Whether a connection has been opted into a biometric gate (stored in settings).
pub async fn is_required(db: &sqlx::SqlitePool, id: &str) -> bool {
    let key = format!("biometric_{id}");
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(&key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false)
}

// ── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use std::path::PathBuf;

    const SWIFT_SRC: &str = r#"import LocalAuthentication
import Foundation
let reason = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Authenticate"
let ctx = LAContext()
var err: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else { exit(2) }
let sema = DispatchSemaphore(value: 0)
var ok = false
ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, _ in
    ok = success; sema.signal()
}
sema.wait()
exit(ok ? 0 : 1)"#;

    /// Path of the cached compiled binary.
    fn bin_path() -> PathBuf {
        std::env::temp_dir().join("Crabeaver Auth")
    }

    /// Ensure the helper binary is compiled. Only recompiles if missing.
    fn ensure_compiled() -> Result<PathBuf, String> {
        let bin = bin_path();
        if bin.exists() {
            return Ok(bin);
        }

        let src = std::env::temp_dir().join("cb_biometric_helper.swift");
        std::fs::write(&src, SWIFT_SRC).map_err(|e| e.to_string())?;

        let out = std::process::Command::new("swiftc")
            .arg(&src)
            .arg("-o")
            .arg(&bin)
            .output()
            .map_err(|e| format!("swiftc not found: {e}"))?;

        let _ = std::fs::remove_file(&src);

        if out.status.success() {
            Ok(bin)
        } else {
            Err(format!("swiftc error: {}", String::from_utf8_lossy(&out.stderr)))
        }
    }

    pub fn available() -> bool {
        // Quick check: can we compile + (implicitly) call evaluatePolicy at all?
        ensure_compiled().is_ok()
    }

    pub fn authenticate(reason: &str) -> Result<(), String> {
        let bin = ensure_compiled()?;

        let status = std::process::Command::new(&bin)
            .arg(reason)
            .status()
            .map_err(|e| format!("Auth helper error: {e}"))?;

        match status.code() {
            Some(0) => Ok(()),
            Some(2) => Err("Touch ID not available on this device".into()),
            _ => Err("Touch ID authentication failed or was cancelled".into()),
        }
    }
}
