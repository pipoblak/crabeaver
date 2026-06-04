/// True iff the `Authorization` header is exactly `Bearer <token>`.
pub fn header_ok(header: Option<&str>, token: &str) -> bool {
    match header {
        Some(h) => h.strip_prefix("Bearer ").map(|t| t == token).unwrap_or(false),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_correct_bearer_only() {
        assert!(header_ok(Some("Bearer abc"), "abc"));
        assert!(!header_ok(Some("Bearer abc"), "xyz"));
        assert!(!header_ok(Some("abc"), "abc")); // no scheme
        assert!(!header_ok(None, "abc")); // missing
    }
}
