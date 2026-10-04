import { useEffect, useState } from "react";
import { type SshHost, sshNative } from "./native";

/**
 * Host list for the main window. Hosts are edited in the settings window, so
 * refresh whenever the main window regains focus instead of polling.
 */
export function useSshHosts(): SshHost[] {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      sshNative
        .listHosts()
        .then((h) => {
          if (alive) setHosts(h);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, []);
  return hosts;
}
