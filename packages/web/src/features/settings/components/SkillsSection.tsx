/**
 * Report Skill management — upload / list / delete pi skill zips used for
 * report generation. Rendered inside SettingsPage's three-panel layout.
 */

import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ReportSkill } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

export function SkillsSection() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string>("");

  const { data, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.skills.list(),
  });

  const uploadMut = useMutation({
    mutationFn: (file: File) => api.skills.upload(file),
    onSuccess: () => {
      setUploadError("");
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) =>
      setUploadError(err instanceof Error ? err.message : String(err)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.skills.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });

  const skills = data?.skills ?? [];

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setUploadError(".zip required");
      e.target.value = "";
      return;
    }
    uploadMut.mutate(file);
    e.target.value = "";
  }

  return (
    <section
      data-testid="settings-card-skills"
      style={{
        background: "var(--bg-card)",
        borderRadius: "12px",
        padding: "24px",
        border: "1px solid var(--border)",
        marginBottom: "16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "18px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontSize: "15px",
              fontWeight: 600,
              margin: "0 0 4px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "var(--text-primary)",
            }}
          >
            <Icon
              name="file-text"
              size={18}
              style={{ color: "var(--text-secondary)" }}
            />
            <span>{i18n.t("skills.title")}</span>
          </h3>
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-secondary)",
              opacity: 0.85,
              margin: 0,
            }}
          >
            {i18n.t("skills.desc")}
          </p>
        </div>
        <div style={{ flexShrink: 0 }}>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            onChange={handleFileSelect}
            style={{ display: "none" }}
            data-testid="skills-upload-input"
          />
          <button
            type="button"
            data-testid="skills-upload-btn"
            disabled={uploadMut.isPending}
            onClick={() => fileRef.current?.click()}
            style={{
              padding: "7px 14px",
              border: "none",
              borderRadius: "6px",
              background: uploadMut.isPending
                ? "var(--bg-disabled)"
                : "var(--brand)",
              color: "var(--btn-primary-text)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: uploadMut.isPending ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <Icon name="upload" size={13} />
            {uploadMut.isPending
              ? i18n.t("skills.uploading")
              : i18n.t("skills.upload")}
          </button>
        </div>
      </div>

      {uploadError && (
        <div
          data-testid="skills-upload-error"
          style={{
            padding: "8px 12px",
            marginBottom: "12px",
            background: "var(--bg-error)",
            color: "var(--brand)",
            border: "1px solid rgba(194,40,40,0.28)",
            borderRadius: "6px",
            fontSize: "12px",
          }}
        >
          {uploadError}
        </div>
      )}

      {isLoading ? (
        <div
          style={{
            padding: "20px 4px",
            color: "var(--text-secondary)",
            fontSize: "13px",
          }}
        >
          …
        </div>
      ) : skills.length === 0 ? (
        <div
          data-testid="skills-empty"
          style={{
            border: "1px dashed var(--border)",
            borderRadius: "10px",
            padding: "28px 16px",
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: "13px",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
            {i18n.t("skills.emptyTitle")}
          </div>
          <p style={{ margin: "0 0 14px", lineHeight: 1.55 }}>
            {i18n.t("skills.emptyBody")}
          </p>
          <button
            type="button"
            data-testid="skills-empty-upload"
            disabled={uploadMut.isPending}
            onClick={() => fileRef.current?.click()}
            style={{
              padding: "7px 14px",
              border: "none",
              borderRadius: "6px",
              background: "var(--brand)",
              color: "var(--btn-primary-text)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <Icon name="upload" size={13} />
            {i18n.t("skills.upload")}
          </button>
        </div>
      ) : (
        <div
          data-testid="skills-list"
          style={{ display: "flex", flexDirection: "column", gap: "6px" }}
        >
          {skills.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              onDelete={() => {
                if (
                  window.confirm(
                    i18n
                      .t("skills.deleteConfirm")
                      .replace("{name}", s.name),
                  )
                )
                  deleteMut.mutate(s.id);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SkillRow({
  skill,
  onDelete,
}: {
  skill: ReportSkill;
  onDelete: () => void;
}) {
  return (
    <div
      data-testid="skill-row"
      data-skill-id={skill.id}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "10px 12px",
        borderRadius: "8px",
        border: "1px solid var(--border)",
        background: "var(--bg-page)",
      }}
    >
      <Icon
        name="file-text"
        size={14}
        style={{ color: "var(--text-secondary)", flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {skill.name}
        </div>
        {skill.description && (
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-secondary)",
              marginTop: "2px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {skill.description}
          </div>
        )}
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-secondary)",
            marginTop: "2px",
            display: "flex",
            gap: "8px",
          }}
        >
          <span>{formatBytes(skill.size_bytes)}</span>
          {skill.attachment_count > 0 && (
            <span>
              ·{" "}
              {i18n
                .t("skills.attachments")
                .replace("{n}", String(skill.attachment_count))}
            </span>
          )}
          <span>· {formatDate(skill.created_at)}</span>
        </div>
      </div>
      <button
        type="button"
        data-testid="skill-delete-btn"
        onClick={onDelete}
        style={{
          padding: "4px 10px",
          border: "1px solid rgba(194,40,40,0.3)",
          borderRadius: "5px",
          background: "var(--bg-card)",
          color: "var(--danger)",
          fontSize: "11px",
          fontWeight: 500,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {i18n.t("skills.delete")}
      </button>
    </div>
  );
}
