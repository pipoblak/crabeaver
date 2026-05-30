-- Passwords migrated to OS keychain; clear any stored plaintext values.
UPDATE connections SET password = NULL;
