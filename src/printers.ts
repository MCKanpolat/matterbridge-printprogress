export type Reading = { progress: number; printing: boolean };
export type PrinterType = "moonraker" | "creality";
export type Reader = (() => Promise<Reading>) & { close?: () => void };

type Json = Record<string, any>;

async function getJson(url: URL, headers: Record<string, string>): Promise<Json> {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as Json;
}

function percentage(value: unknown): number {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 100)
    throw new Error("Invalid print progress");
  return Math.round(number);
}

export function moonrakerReader(base: string, apiKey?: string): Reader {
  const headers: Record<string, string> = apiKey ? { "X-Api-Key": apiKey } : {};
  const queryUrl = new URL(base);
  const prefix = queryUrl.pathname.replace(/\/$/, "");
  queryUrl.pathname = `${prefix}/printer/objects/query`;
  queryUrl.search =
    "print_stats=state,filename&display_status=progress&virtual_sdcard=progress,file_position";
  let cachedFile: { name: string; start?: number; end?: number; retryAt: number } | undefined;

  return async () => {
    const body = await getJson(queryUrl, headers);
    const status = body.result?.status;
    const { state, filename } = status?.print_stats ?? {};
    if (state === "complete" || state === "standby" || state === "cancelled") {
      cachedFile = undefined;
      return { progress: state === "complete" ? 100 : 0, printing: false };
    }
    if (state !== "printing" && state !== "paused" && state !== "error")
      throw new Error("Could not read Moonraker print status");

    const sd = status.virtual_sdcard;
    if (
      filename &&
      Number.isFinite(sd?.file_position) &&
      (cachedFile?.name !== filename || Date.now() >= (cachedFile?.retryAt ?? 0))
    ) {
      const metadataUrl = new URL(queryUrl);
      metadataUrl.pathname = `${prefix}/server/files/metadata`;
      metadataUrl.search = new URLSearchParams({ filename }).toString();
      const metadata = await getJson(metadataUrl, headers).catch(() => null);
      cachedFile = {
        name: filename,
        start: metadata?.result?.gcode_start_byte,
        end: metadata?.result?.gcode_end_byte,
        retryAt: metadata ? Infinity : Date.now() + 30000,
      };
    }

    let progress: unknown = sd?.progress ?? status.display_status?.progress;
    const file = cachedFile?.name === filename ? cachedFile : undefined;
    const { start, end } = file ?? {};
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      (end as number) > (start as number) &&
      Number.isFinite(sd?.file_position)
    ) {
      progress = Math.max(
        0,
        Math.min(1, (sd.file_position - (start as number)) / ((end as number) - (start as number))),
      );
    }
    if (typeof progress === "string" && progress.trim()) progress = Number(progress);
    if (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 1)
      throw new Error("Invalid print progress");
    return { progress: Math.floor(progress * 100), printing: state !== "error" };
  };
}

/**
 * Keeps one WebSocket open per printer and returns the latest cached values.
 * Reconnects with backoff, so polling costs no network round trip or handshake.
 */
export function crealityReader(url: string): Reader {
  const STALE_MS = 30_000;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 2_000;
  let closed = false;
  let deviceState: string | undefined;
  let progress: unknown;
  let lastData = 0;

  const request = JSON.stringify({
    method: "get",
    params: { deviceState: 1, printProgress: 1, state: 1 },
  });

  function connect(): void {
    if (closed || socket) return;
    const current = new WebSocket(url);
    socket = current;
    current.addEventListener("open", () => {
      retryDelay = 2_000;
      current.send(request);
    });
    current.addEventListener("message", ({ data }) => {
      if (data === "heart_beat") {
        if (current.readyState === WebSocket.OPEN) current.send("ok");
        return;
      }
      try {
        const update = JSON.parse(String(data));
        if (update?.deviceState != null) deviceState = String(update.deviceState);
        if (update?.printProgress != null) progress = update.printProgress;
        lastData = Date.now();
      } catch {
        // Ignore non-JSON frames.
      }
    });
    const drop = (): void => {
      if (socket !== current) return;
      socket = undefined;
      deviceState = undefined;
      progress = undefined;
      if (closed) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60_000);
    };
    current.addEventListener("error", drop);
    current.addEventListener("close", drop);
  }

  const read: Reader = async () => {
    connect();
    // Ask for a fresh snapshot; the answer lands in the cache for the next read.
    if (socket?.readyState === WebSocket.OPEN) socket.send(request);
    // Right after connecting there is no data yet: wait briefly for the first snapshot.
    for (let i = 0; i < 30 && (deviceState === undefined || progress === undefined); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (deviceState === undefined || progress === undefined || Date.now() - lastData > STALE_MS)
      throw new Error("No data from printer");
    const value = percentage(progress);
    return {
      progress: deviceState === "0" && value < 100 ? 0 : value,
      printing: deviceState !== "0",
    };
  };
  read.close = () => {
    closed = true;
    clearTimeout(retryTimer);
    socket?.close();
    socket = undefined;
  };
  return read;
}

export function createReader(type: PrinterType, url: string, apiKey?: string): Reader {
  return type === "creality" ? crealityReader(url) : moonrakerReader(url, apiKey);
}
