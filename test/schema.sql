DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    organization_id INT NOT NULL,
    email VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed: 99% 'active', 1% 'pending' (realistic status queue distribution)
INSERT INTO users (organization_id, email, status)
SELECT (i % 50), 'user_' || i || '@company.com', CASE WHEN i % 100 = 0 THEN 'pending' ELSE 'active' END
FROM generate_series(1, 10000) i;

INSERT INTO audit_logs (user_id, action, created_at)
SELECT (i % 10000) + 1, 'USER_LOGIN', CURRENT_TIMESTAMP - (i || ' minutes')::interval
FROM generate_series(1, 10000) i;

-- Non-blocking covering indexes
CREATE INDEX CONCURRENTLY idx_users_organization_id ON users(organization_id);
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
CREATE INDEX CONCURRENTLY idx_users_status ON users(status);
CREATE INDEX CONCURRENTLY idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX CONCURRENTLY idx_audit_logs_user_id ON audit_logs(user_id);

ANALYZE users;
ANALYZE audit_logs;
