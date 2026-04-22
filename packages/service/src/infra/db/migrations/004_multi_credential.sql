-- Multi-credential support: tasks and chat_sessions can reference a specific credential
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS credential_id UUID REFERENCES llm_credentials(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS credential_id UUID REFERENCES llm_credentials(id) ON DELETE SET NULL;
