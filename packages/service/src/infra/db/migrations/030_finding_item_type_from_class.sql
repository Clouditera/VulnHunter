-- VulnForge 2 stores both vulnerabilities and risks under findings/BUG-* and
-- distinguishes them with finding_class. Correct rows indexed before the
-- platform started treating that structured field as authoritative.
UPDATE findings_meta
SET item_type = 'risk'
WHERE finding_class = 'risk'
  AND item_type IS DISTINCT FROM 'risk';
