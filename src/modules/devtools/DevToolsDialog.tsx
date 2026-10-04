import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type DevToolsTab, useDevTools } from "./store";
import {
  AgentsPanel,
  ApiPanel,
  DatabasePanel,
  DockerPanel,
  GithubPanel,
  HealthPanel,
  ProjectPanel,
  type PanelProps,
} from "./panels";

const TABS: Array<[DevToolsTab, string, (p: PanelProps) => React.ReactNode]> = [
  ["project", "Project", (p) => <ProjectPanel {...p} />],
  ["health", "Health", (p) => <HealthPanel {...p} />],
  ["docker", "Docker", (p) => <DockerPanel {...p} />],
  ["database", "Database", (p) => <DatabasePanel {...p} />],
  ["api", "API", (p) => <ApiPanel {...p} />],
  ["github", "GitHub", (p) => <GithubPanel {...p} />],
  ["agents", "Agents", (p) => <AgentsPanel {...p} />],
];

export function DevToolsDialog(props: Omit<PanelProps, "close">) {
  const { open, tab, show, close } = useDevTools();
  const panelProps: PanelProps = { ...props, close };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[72vh] max-w-3xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Dev tools</DialogTitle>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(v) => show(v as DevToolsTab)}
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          <TabsList>
            {TABS.map(([id, label]) => (
              <TabsTrigger key={id} value={id} className="text-[11.5px]">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {TABS.map(([id, , render]) => (
            <TabsContent
              key={id}
              value={id}
              className="min-h-0 flex-1 overflow-y-auto pr-1"
            >
              {tab === id ? render(panelProps) : null}
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
