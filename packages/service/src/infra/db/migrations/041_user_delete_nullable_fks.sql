-- Keep historical tasks when deleting a user (creator shown as deleted in UI).
ALTER TABLE tasks ALTER COLUMN created_by DROP NOT NULL;
