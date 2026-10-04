import {
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal/lib/useTerminalSession";

export type NewTerminalTab = (
  cwd: string | undefined,
  title: string,
) => { tabId: number; leafId: number };

/** Opens a new terminal tab and types `line` into it. The user sees and can stop it. */
export async function runInNewTab(
  line: string,
  title: string,
  cwd: string | null,
  newTab: NewTerminalTab,
): Promise<boolean> {
  const { leafId } = newTab(cwd ?? undefined, title);
  await whenSessionReady(leafId);
  return writeToSession(leafId, `${line}\r`);
}
