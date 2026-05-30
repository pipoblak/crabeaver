-- Add password column and ssl_mode to connections
ALTER TABLE connections ADD COLUMN password TEXT;
ALTER TABLE connections ADD COLUMN ssl_mode TEXT NOT NULL DEFAULT 'prefer';
ALTER TABLE connections ADD COLUMN connection_string TEXT;
