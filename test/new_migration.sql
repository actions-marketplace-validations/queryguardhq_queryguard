-- New index missing CONCURRENTLY (Must be flagged as SHARE lock)
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
