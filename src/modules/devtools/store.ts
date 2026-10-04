import { create } from "zustand";

export type DevToolsTab =
  | "project"
  | "health"
  | "docker"
  | "database"
  | "api"
  | "github"
  | "agents";

type State = {
  open: boolean;
  tab: DevToolsTab;
  show: (tab: DevToolsTab) => void;
  close: () => void;
};

export const useDevTools = create<State>((set) => ({
  open: false,
  tab: "project",
  show: (tab) => set({ open: true, tab }),
  close: () => set({ open: false }),
}));
