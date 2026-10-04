import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  type SshHost,
  type SshHostInput,
  sshNative,
} from "@/modules/ssh/lib/native";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const EMPTY: SshHostInput = {
  label: "",
  target: "",
  user: "",
  port: null,
  identity_file: "",
  remote_dir: "",
};

export function SshSection() {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [editing, setEditing] = useState<SshHostInput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    sshNative
      .listHosts()
      .then(setHosts)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);

  const saved = hosts.filter((h) => h.source === "saved");
  const fromConfig = hosts.filter((h) => h.source === "config");

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="SSH"
        description="Remote servers for the SSH terminal and AI remote tools. Myko never stores passwords or private keys: key files are referenced by path, and password / host-key prompts happen in the terminal."
      />
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-medium">Servers</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() => setEditing({ ...EMPTY })}
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            Add server
          </Button>
        </div>
        {saved.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No servers yet. Connect from the command palette with “SSH: …”.
          </p>
        ) : (
          saved.map((h) => (
            <HostRow
              key={h.id}
              host={h}
              onEdit={() =>
                setEditing({
                  id: h.id,
                  label: h.label,
                  target: h.target,
                  user: h.user ?? "",
                  port: h.port,
                  identity_file: h.identity_file ?? "",
                  remote_dir: h.remote_dir ?? "",
                })
              }
              onDelete={() =>
                void sshNative
                  .deleteHost(h.id)
                  .then(reload)
                  .catch((e) => setError(String(e)))
              }
            />
          ))
        )}
      </section>

      {fromConfig.length > 0 ? (
        <section className="flex flex-col gap-2">
          <span className="text-[12.5px] font-medium">From ~/.ssh/config</span>
          {fromConfig.map((h) => (
            <HostRow key={h.id} host={h} />
          ))}
        </section>
      ) : null}

      <HostDialog
        value={editing}
        onClose={() => setEditing(null)}
        onSave={async (v) => {
          await sshNative.saveHost(v);
          setEditing(null);
          reload();
        }}
      />
    </div>
  );
}

function HostRow({
  host,
  onEdit,
  onDelete,
}: {
  host: SshHost;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const where = `${host.user ? `${host.user}@` : ""}${host.target}${host.port ? `:${host.port}` : ""}`;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[12.5px] font-medium">{host.label}</span>
        <span className="truncate font-mono text-[10.5px] text-muted-foreground">
          {where}
          {host.remote_dir ? ` · ${host.remote_dir}` : ""}
        </span>
      </div>
      <div className="flex shrink-0 gap-1">
        {onEdit ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="Edit"
            onClick={onEdit}
          >
            <HugeiconsIcon icon={Edit02Icon} size={13} strokeWidth={1.75} />
          </Button>
        ) : null}
        {onDelete ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="Delete"
            onClick={onDelete}
          >
            <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function HostDialog({
  value,
  onClose,
  onSave,
}: {
  value: SshHostInput | null;
  onClose: () => void;
  onSave: (v: SshHostInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SshHostInput>(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (value) {
      setDraft(value);
      setErr(null);
    }
  }, [value]);

  const set = (patch: Partial<SshHostInput>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const field = (
    label: string,
    key: "label" | "target" | "user" | "identity_file" | "remote_dir",
    placeholder: string,
  ) => (
    <label
      htmlFor={`ssh-${key}`}
      className="flex flex-col gap-1 text-[11px] text-muted-foreground"
    >
      {label}
      <Input
        id={`ssh-${key}`}
        value={(draft[key] as string | null | undefined) ?? ""}
        placeholder={placeholder}
        onChange={(e) => set({ [key]: e.target.value })}
        spellCheck={false}
        autoComplete="off"
      />
    </label>
  );

  return (
    <Dialog open={value !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{draft.id ? "Edit server" : "Add server"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {field("Name", "label", "Production")}
          {field("Host", "target", "example.com or ssh_config alias")}
          {field("User", "user", "deploy")}
          <label
            htmlFor="ssh-port"
            className="flex flex-col gap-1 text-[11px] text-muted-foreground"
          >
            Port
            <Input
              id="ssh-port"
              inputMode="numeric"
              value={draft.port ?? ""}
              placeholder="22"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                set({ port: Number.isFinite(n) ? n : null });
              }}
            />
          </label>
          {field(
            "Private key file (optional)",
            "identity_file",
            "~/.ssh/id_ed25519",
          )}
          {field("Remote directory (optional)", "remote_dir", "/srv/app")}
          {err ? <p className="text-[11px] text-destructive">{err}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void onSave(draft).catch((e) => setErr(String(e)))}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
