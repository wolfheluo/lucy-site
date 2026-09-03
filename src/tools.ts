// =====================================================================
//  client tool registry：新 tool 在此加一行 { meta, Component }
//  作品卡（projectCard）自動併入作品集 Projects 區
// =====================================================================
import { lazy, type ComponentType } from "react";
import type { ToolMeta, ToolProjectCard } from "../tools/types";
import { fileVaultMeta, fileVaultProjectCard } from "../tools/file-vault/meta";

export interface ClientTool {
  meta: ToolMeta;
  Component: ComponentType;
  projectCard?: ToolProjectCard;
}

const FileVaultPage = lazy(() => import("../tools/file-vault/client/FileVaultPage"));

export const CLIENT_TOOLS: ClientTool[] = [
  { meta: fileVaultMeta, Component: FileVaultPage, projectCard: fileVaultProjectCard },
];

export interface ToolProjectEntry extends ToolProjectCard {
  idx: string;
  href: string;
}

/** 由 tool manifest 產生作品卡：接在 content.ts 手動作品之後自動編號（手動 N 筆 → tool 由 P-(N+1) 起跳） */
export function toolProjectCards(manualCount: number): ToolProjectEntry[] {
  let seq = manualCount;
  const out: ToolProjectEntry[] = [];
  for (const t of CLIENT_TOOLS) {
    if (!t.projectCard) continue;
    seq += 1;
    out.push({
      ...t.projectCard,
      idx: `P-${String(seq).padStart(2, "0")}`,
      href: `/tools/${t.meta.id}`,
    });
  }
  return out;
}
