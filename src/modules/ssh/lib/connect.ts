import {
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal/lib/useTerminalSession";
import { sshNative } from "./native";

type NewTerminalTab = (
  cwd: string | undefined,
  title: string,
) => { tabId: number; leafId: number };

/**
 * Opens a new local terminal tab and starts `ssh` in it. Password and
 * host-key prompts are answered by the user inside that terminal; nothing
 * secret passes through the UI.
 */
export async function connectSsh(
  hostId: string,
  label: string,
  newTerminalTab: NewTerminalTab,
): Promise<boolean> {
  const line = await sshNative.terminalCommand(hostId);
  const { leafId } = newTerminalTab(undefined, `ssh · ${label}`);
  await whenSessionReady(leafId);
  return writeToSession(leafId, `${line}\r`);
}
