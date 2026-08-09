# Security Policy

## Lawful use (users of VulnHunter)

VulnHunter is for **authorized security research and testing only**.

- Test **only** systems, codebases, and services you **own** or are **explicitly authorized** to assess.
- **Do not** use VulnHunter for unauthorized scanning, intrusion, data theft, extortion, disruption, or any other illegal activity.
- Unauthorized or illegal use is solely the operator's responsibility.

This section is about **how people must use the product**. The rest of this document is about **reporting defects in VulnHunter itself**.

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.3.x   | ✅ Security fixes |
| 2.2.x   | ⚠️ Critical fixes only (limited window) |
| < 2.2   | ❌ Please upgrade |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately so we can fix and coordinate disclosure before public discussion.

### Preferred channels

1. **Email:** `security@clouditera.com`  
   - Use a clear subject, e.g. `[SECURITY] VulnHunter <short title>`
2. If email is unavailable, open a **private security advisory** on this repository  
   (GitHub → Security → Advisories → New draft advisory), when the repository allows it.

### What to include

- Affected component (service / web / worker / deploy scripts / docs)
- Version or git commit
- Reproduction steps or PoC (non-destructive preferred)
- Impact assessment (auth bypass, RCE, data exposure, etc.)
- Whether you plan a public write-up and preferred timeline

### Our commitment

- Acknowledge receipt within **3 business days**
- Initial triage within **7 business days**
- Keep you informed of progress; credit reporters who want it (unless you prefer anonymity)
- Coordinate disclosure after a fix is available or after an agreed embargo

### Scope notes

- **In scope:** VulnHunter open-source platform code in this repository, default deploy scripts, and documented configurations.
- **Out of scope (examples):** third-party model providers, customer-deployed infrastructure misconfiguration, social engineering, DoS without a security boundary bug.
- Findings in **commercial / SaaS-only** modules belong to the private product line — still welcome via the same email; they are not tracked in this public repo.
- Reports that describe **unauthorized testing of third-party systems** (using VulnHunter or otherwise) are not a vulnerability report to this project; we do not accept or coordinate such activity.

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and service disruption
- Do not exploit the issue beyond what is needed to demonstrate it
- Report promptly and do not publicly disclose before coordinated release

Thank you for helping keep VulnHunter and its users safe.
