DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    organization_id INT NOT NULL,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed 10,000 synthetic rows (<50ms execution) to give PostgreSQL real disk pages
INSERT INTO users (organization_id, email)
SELECT (i % 50), 'user_' || i || '@company.com'
FROM generate_series(1, 10000) i;

INSERT INTO audit_logs (user_id, action, created_at)
SELECT (i % 10000) + 1, 'USER_LOGIN', CURRENT_TIMESTAMP - (i || ' minutes')::interval
FROM generate_series(1, 10000) i;

ANALYZE users;
ANALYZE audit_logs;
