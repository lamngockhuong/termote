import { Caption } from "../components/caption";
import { DesktopShots } from "../components/desktop-shots";

// A new worktree of acme-api on its own branch, then its workspace in the
// sidebar (pwa/e2e/capture-video.spec.ts, "desktop worktree")
export const WorktreeScene: React.FC = () => (
  <DesktopShots
    caption={
      <Caption
        align="center"
        title="A worktree for each task."
        sub="Branch off into a new worktree and workspace, so agents never step on each other."
      />
    }
    shots={[
      { at: 0, src: "desktop-worktree-new" },
      { at: 105, src: "desktop-worktree" },
    ]}
  />
);
