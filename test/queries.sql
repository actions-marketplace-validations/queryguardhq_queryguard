SELECT * FROM users WHERE organization_id = 42;

SELECT * FROM users WHERE email = 'sample_42active';

SELECT * FROM users WHERE status = 'pending';

-- Unindexed regression on audit_logs
SELECT * FROM audit_logs WHERE action = 'sample_100pending';
