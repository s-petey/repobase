import { TextAttributes } from "@opentui/core";
import type { RepoConfig } from "@repobase/engine";
import { Option } from "effect";
import { colors } from "../theme/index.js";

export type FlatRow =
  | { kind: "header"; owner: string; repoCount: number; collapsed: boolean }
  | { kind: "repo"; repo: RepoConfig };

interface RepoListProps {
  flatRows: FlatRow[];
  selectedIndex: number;
  totalRepoCount: number;
}

const formatMode = (repo: RepoConfig): string => {
  if (repo.mode._tag === "tracking") {
    return `tracking: ${repo.mode.branch}`;
  }
  return `pinned: ${repo.mode.ref}`;
};

const formatStatus = (repo: RepoConfig): { text: string; color: string } => {
  if (repo.mode._tag === "pinned") {
    return { text: "o pinned", color: colors.text.secondary };
  }
  return Option.isSome(repo.lastSyncedCommit)
    ? { text: "+ synced", color: colors.status.success.default }
    : { text: "o pending", color: colors.status.warning.default };
};

const formatCloudStatus = (repo: RepoConfig): string => {
  if (!repo.cloudEnabled) return "";

  // Check if cloud is in sync with local
  const localCommit = Option.getOrNull(repo.lastSyncedCommit);
  const cloudCommit = repo.lastPushedCommit ? Option.getOrNull(repo.lastPushedCommit) : null;

  if (localCommit && cloudCommit && localCommit === cloudCommit) {
    return "[C]";
  } else if (repo.cloudEnabled) {
    return "[C^]";
  }
  return "";
};

const repoCountLabel = (count: number): string => {
  return `${count} repo${count !== 1 ? "s" : ""}`;
};

export const RepoList = ({ flatRows, selectedIndex, totalRepoCount }: RepoListProps) => {
  if (flatRows.length === 0) {
    return (
      <box
        style={{
          flexGrow: 1,
          padding: 1,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <text content="No repositories configured." style={{ fg: colors.text.secondary }} />
        <text content="Press [a] to add one." style={{ fg: colors.text.tertiary, marginTop: 1 }} />
      </box>
    );
  }

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text
        content={`Repositories (${totalRepoCount})`}
        style={{
          fg: colors.text.primary,
          attributes: TextAttributes.BOLD,
          marginBottom: 1,
        }}
      />
      <scrollbox
        focused
        style={{
          flexGrow: 1,
        }}
      >
        {flatRows.map((row, index) => {
          const isSelected = index === selectedIndex;
          const prefix = isSelected ? "> " : "  ";

          if (row.kind === "header") {
            const icon = row.collapsed ? "\u25B6" : "\u25BC";
            return (
              <box
                key={`header-${row.owner}`}
                style={{
                  flexDirection: "row",
                  backgroundColor: isSelected ? colors.bg.selected : undefined,
                  padding: 0,
                }}
              >
                <text
                  content={`${prefix}${icon} ${row.owner} (${repoCountLabel(row.repoCount)})`}
                  style={{
                    fg: isSelected ? colors.text.primary : colors.accent.default,
                    attributes: isSelected ? TextAttributes.BOLD : TextAttributes.DIM,
                  }}
                />
              </box>
            );
          }

          const repo = row.repo;
          const status = formatStatus(repo);
          const mode = formatMode(repo);
          const cloudStatus = formatCloudStatus(repo);

          return (
            <box
              key={repo.id}
              style={{
                flexDirection: "row",
                backgroundColor: isSelected ? colors.bg.selected : undefined,
                padding: 0,
              }}
            >
              <text
                content={`${prefix}  ${repo.id.padEnd(24)} ${mode.padEnd(18)} ${status.text.padEnd(12)} ${cloudStatus}`}
                style={{
                  fg: isSelected ? colors.text.primary : colors.interactive.default,
                  attributes: isSelected ? TextAttributes.BOLD : undefined,
                }}
              />
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
};
