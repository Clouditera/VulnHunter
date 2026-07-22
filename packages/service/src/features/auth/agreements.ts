import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface AgreementDef {
  id: string;
  title: string;
  version: string;
  effective_date: string;
  /** relative filename under legal/ */
  html_file: string;
  required_on_register: boolean;
}

/** Agreements required at registration (fish 2026-07-22: all three shipped docs). */
export const REGISTER_AGREEMENTS: AgreementDef[] = [
  {
    id: "user-service",
    title: "VulHunter 平台用户服务协议",
    version: "1.0",
    effective_date: "2026-07-21",
    html_file: "user-service.html",
    required_on_register: true,
  },
  {
    id: "privacy-policy",
    title: "VulHunter 平台隐私政策",
    version: "1.0",
    effective_date: "2026-07-21",
    html_file: "privacy-policy.html",
    required_on_register: true,
  },
  {
    id: "saas-service",
    title: "VulHunter SaaS 平台服务协议及软件许可条款",
    version: "1.1",
    effective_date: "2026-07-21",
    html_file: "saas-service.html",
    required_on_register: true,
  },
];

function legalDir(): string {
  // Prefer packaged dist path next to this module; fall back to src for dev.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "legal"),
    join(here, "../legal"),
    join(process.cwd(), "packages/service/src/features/auth/legal"),
    join(process.cwd(), "src/features/auth/legal"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "user-service.html"))) return c;
  }
  return candidates[0];
}

export function listRegisterAgreements(): Array<Omit<AgreementDef, "html_file"> & { html_url: string }> {
  return REGISTER_AGREEMENTS.map(({ html_file: _h, ...rest }) => ({
    ...rest,
    html_url: `/api/auth/agreements/${rest.id}`,
  }));
}

export function getAgreementHtml(id: string): { def: AgreementDef; html: string } | null {
  const def = REGISTER_AGREEMENTS.find((a) => a.id === id);
  if (!def) return null;
  const path = join(legalDir(), def.html_file);
  if (!existsSync(path)) return null;
  return { def, html: readFileSync(path, "utf8") };
}

export async function recordRegisterAcceptances(userId: string, acceptedAt = new Date()): Promise<void> {
  const db = getDb();
  for (const a of REGISTER_AGREEMENTS.filter((x) => x.required_on_register)) {
    await db`
      INSERT INTO user_agreement_acceptances
        (tenant_id, user_id, agreement_id, agreement_title, agreement_version, accepted_at)
      VALUES (
        ${DEFAULT_TENANT_ID},
        ${userId},
        ${a.id},
        ${a.title},
        ${a.version},
        ${acceptedAt}
      )
      ON CONFLICT (user_id, agreement_id, agreement_version) DO NOTHING
    `;
  }
}

export interface AcceptanceRow {
  agreement_id: string;
  agreement_title: string;
  agreement_version: string;
  accepted_at: Date;
}

export async function listAcceptancesForUser(userId: string): Promise<AcceptanceRow[]> {
  const db = getDb();
  return db<AcceptanceRow[]>`
    SELECT agreement_id, agreement_title, agreement_version, accepted_at
    FROM user_agreement_acceptances
    WHERE user_id = ${userId}
    ORDER BY accepted_at ASC, agreement_id ASC
  `;
}

export async function listAcceptancesForUsers(userIds: string[]): Promise<Map<string, AcceptanceRow[]>> {
  const map = new Map<string, AcceptanceRow[]>();
  if (userIds.length === 0) return map;
  const db = getDb();
  const rows = await db<(AcceptanceRow & { user_id: string })[]>`
    SELECT user_id, agreement_id, agreement_title, agreement_version, accepted_at
    FROM user_agreement_acceptances
    WHERE user_id = ANY(${userIds})
    ORDER BY accepted_at ASC, agreement_id ASC
  `;
  for (const r of rows) {
    const list = map.get(r.user_id) ?? [];
    list.push({
      agreement_id: r.agreement_id,
      agreement_title: r.agreement_title,
      agreement_version: r.agreement_version,
      accepted_at: r.accepted_at,
    });
    map.set(r.user_id, list);
  }
  return map;
}
