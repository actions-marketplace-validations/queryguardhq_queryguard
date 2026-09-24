SELECT * FROM users WHERE organization_id = 42;

SELECT * FROM users WHERE id = 101;

SELECT u.email, a.action 
FROM users u 
JOIN audit_logs a ON u.id = a.user_id 
WHERE a.created_at > NOW() - INTERVAL '30 minutes';

SELECT * FROM users WHERE email = 'target_user@company.com';

SELECT * FROM users WHERE status = 'pending';
