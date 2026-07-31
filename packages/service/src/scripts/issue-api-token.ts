#!/usr/bin/env node
/**
 * Issue a long-lived API token for a service account.
 *
 * Usage:
 *   node dist/scripts/issue-api-token.js --email <service-account-email> --name <token-name>
 *
 * If the user does not exist it is created as a role=member service account
 * (member is mandatory — forbidAdmin blocks admin accounts from the business
 * APIs the token is meant to call). A random password is set; the account is
 * expected to authenticate via the token, not a password.
 *
 * The plaintext token is printed to stdout exactly once and is never
 * recoverable afterwards — only its sha256 hash is stored.
 *
 * DB connection uses DATABASE_URL (same as the service).
 */
import { randomBytes } from "node:crypto";
import { issueApiToken } from "../features/auth/api-token-storage.js";
import { createUserAccount } from "../features/auth/service.js";
import { findUserByEmail } from "../features/auth/storage.js";
import { loadConfig } from "../infra/config.js";
import { closeDb, initDb } from "../infra/db/client.js";

interface Args {
  email: string;
  name: string;
}

function parseArgs(argv: string[]): Args {
  let email: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--email") email = argv[++i];
    else if (arg === "--name") name = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    }
  }
  if (!email || !name) {
    printUsageAndExit(2);
  }
  return { email: email.toLowerCase(), name };
}

function printUsageAndExit(code: number): never {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(
    "Usage: node dist/scripts/issue-api-token.js --email <service-account-email> --name <token-name>\n",
  );
  process.exit(code);
}

async function main(): Promise<void> {
  const { email, name } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  await initDb(config.db.url);
  try {
    let user = await findUserByEmail(email);
    if (!user) {
      // Random password: the service account authenticates via token, not password.
      user = await createUserAccount({
        email,
        password: randomBytes(24).toString("base64url"),
        role: "member",
        mustChangePassword: false,
        source: "admin",
      });
      process.stderr.write(`Created service account ${email} (role=member).\n`);
    } else if (user.role !== "member") {
      throw new Error(
        `User ${email} has role=${user.role}; API tokens must belong to a member account (admin accounts are blocked from business APIs by forbidAdmin).`,
      );
    }

    const { id, token } = await issueApiToken(user.id, name);
    process.stderr.write(`Issued token "${name}" (id=${id}) for ${email}.\n`);
    process.stderr.write("The token is shown ONCE below and cannot be recovered later:\n");
    process.stdout.write(`${token}\n`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  process.stderr.write(
    `Failed to issue API token: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
