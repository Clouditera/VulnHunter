-- 034: one-shot purge of empty chat sessions (no messages)
-- Cascades via FK to messages/artifacts/etc. when present.
DELETE FROM chat_sessions s
WHERE NOT EXISTS (
  SELECT 1 FROM chat_messages m WHERE m.session_id = s.id
);
