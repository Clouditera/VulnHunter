-- SandboxPlane v0.3.2: persist internal SSH host (bastion jump) + host public key (#7 pin).
ALTER TABLE task_sandboxes
  ADD COLUMN IF NOT EXISTS ssh_internal_host TEXT,
  ADD COLUMN IF NOT EXISTS ssh_host_public_key TEXT;
