-- Chat assistant messages persist their tool calls (Reference + Artifact cards)
-- so the cards survive a refresh / reopen. Previously appendMessage dropped the
-- toolCalls param entirely; this column carries the full tool_calls array that
-- the frontend's extractAllArtifacts already reads to rebuild cards.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tool_calls JSONB;
