import { SAFE_NAME, shq } from "./shq";

export type DockerContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
};
export type DockerImage = {
  id: string;
  repo: string;
  tag: string;
  size: string;
};
export type DockerVolume = { name: string; driver: string };
export type DockerNetwork = { id: string; name: string; driver: string };

export const DOCKER_LIST = {
  containers: `docker ps -a --format '{{json .}}'`,
  images: `docker images --format '{{json .}}'`,
  volumes: `docker volume ls --format '{{json .}}'`,
  networks: `docker network ls --format '{{json .}}'`,
} as const;

function jsonLines(out: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {}
  }
  return rows;
}

export const parseContainers = (out: string): DockerContainer[] =>
  jsonLines(out).map((r) => ({
    id: r.ID ?? "",
    name: r.Names ?? "",
    image: r.Image ?? "",
    state: r.State ?? "",
    status: r.Status ?? "",
    ports: r.Ports ?? "",
  }));
export const parseImages = (out: string): DockerImage[] =>
  jsonLines(out).map((r) => ({
    id: r.ID ?? "",
    repo: r.Repository ?? "",
    tag: r.Tag ?? "",
    size: r.Size ?? "",
  }));
export const parseVolumes = (out: string): DockerVolume[] =>
  jsonLines(out).map((r) => ({ name: r.Name ?? "", driver: r.Driver ?? "" }));
export const parseNetworks = (out: string): DockerNetwork[] =>
  jsonLines(out).map((r) => ({
    id: r.ID ?? "",
    name: r.Name ?? "",
    driver: r.Driver ?? "",
  }));

export type ContainerAction = "start" | "stop" | "restart";

/** Throws if the id/name is not a plain docker identifier. */
export function containerCommand(
  action: ContainerAction | "logs" | "shell",
  id: string,
): string {
  if (!SAFE_NAME.test(id)) throw new Error("invalid container id");
  switch (action) {
    case "logs":
      return `docker logs --tail 200 ${id} 2>&1`;
    case "shell":
      return `docker exec -it ${id} sh -c ${shq("command -v bash >/dev/null && exec bash || exec sh")}`;
    default:
      return `docker ${action} ${id}`;
  }
}
