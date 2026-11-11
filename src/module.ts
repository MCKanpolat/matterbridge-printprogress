import {
  contactSensor,
  dimmableLight,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  type BasePlatformConfig,
  type PlatformMatterbridge,
} from "matterbridge";
import type { AnsiLogger, LogLevel } from "matterbridge/logger";
import {
  BooleanState,
  BridgedDeviceBasicInformation,
  LevelControl,
  OnOff,
} from "matterbridge/matter/clusters";
import { createReader, type PrinterType, type Reader, type Reading } from "./printers.js";

export type PrinterConfig = {
  id: string;
  name: string;
  type?: PrinterType;
  url: string;
  apiKey?: string;
  manufacturer?: string;
  model?: string;
};

export type PrintProgressConfig = BasePlatformConfig & {
  printers: PrinterConfig[];
  pollingInterval?: number;
  debug?: boolean;
};

type Printer = {
  config: PrinterConfig;
  read: Reader;
  light: MatterbridgeEndpoint;
  sensor: MatterbridgeEndpoint;
  last?: Reading | null;
};

const MAX_LEVEL = 254;
const toLevel = (progress: number): number =>
  Math.max(1, Math.min(MAX_LEVEL, Math.round((progress / 100) * MAX_LEVEL)));

export default function initializePlugin(
  matterbridge: PlatformMatterbridge,
  log: AnsiLogger,
  config: PrintProgressConfig,
): PrintProgressPlatform {
  return new PrintProgressPlatform(matterbridge, log, config);
}

export class PrintProgressPlatform extends MatterbridgeDynamicPlatform {
  private readonly printers: Printer[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private pollTask?: Promise<void>;
  private stopped = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PrintProgressConfig) {
    super(matterbridge, log, config);
    if (
      typeof this.verifyMatterbridgeVersion !== "function" ||
      !this.verifyMatterbridgeVersion("3.10.0")
    )
      throw new Error("This plugin requires Matterbridge >= 3.10.0");
  }

  override async onStart(reason?: string): Promise<void> {
    await this.ready;
    await this.clearSelect();
    this.log.info(`Print Progress starting (${reason ?? "startup"})`);
    const config = this.config as PrintProgressConfig;
    for (const entry of config.printers ?? []) {
      if (!entry?.id || !entry.name || !entry.url) {
        this.log.error("Skipping printer without id, name and url");
        continue;
      }
      this.printers.push(await this.register(entry, entry.type ?? "moonraker"));
    }
    const interval = Number(config.pollingInterval ?? 3);
    this.pollTimer = setInterval(
      () => void this.poll(),
      (Number.isFinite(interval) ? Math.max(1, interval) : 3) * 1000,
    );
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    await this.poll();
  }
  override async onChangeLoggerLevel(_logLevel: LogLevel): Promise<void> {}
  override async onShutdown(reason?: string): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    await this.pollTask;
    this.printers.length = 0;
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  private async register(entry: PrinterConfig, type: PrinterType): Promise<Printer> {
    const manufacturer = entry.manufacturer || "PrintProgress";
    const model = entry.model || "Print Progress";
    const progressName = `${entry.name} Print Progress`;
    const statusName = `${entry.name} Print Status`;

    // The progress light is read-only: any command is undone on the next refresh.
    const restore = (): void => void setTimeout(() => void this.refresh(printer), 300);
    const light = new MatterbridgeEndpoint(dimmableLight, { id: `${entry.id}-progress` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        progressName,
        `${entry.id}-progress`,
        this.matterbridge.aggregatorVendorId,
        manufacturer,
        model,
        10000,
        "1.0.0",
      )
      .createDefaultOnOffClusterServer(false)
      .createDefaultLevelControlClusterServer(1, 1, MAX_LEVEL)
      .addRequiredClusters()
      .addCommandHandler("on", restore)
      .addCommandHandler("off", restore)
      .addCommandHandler("toggle", restore)
      .addCommandHandler("moveToLevel", restore)
      .addCommandHandler("moveToLevelWithOnOff", restore);

    // Matter BooleanState: true means contact (closed). Open means printing.
    const sensor = new MatterbridgeEndpoint(contactSensor, { id: `${entry.id}-status` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        statusName,
        `${entry.id}-status`,
        this.matterbridge.aggregatorVendorId,
        manufacturer,
        model,
        10000,
        "1.0.0",
      )
      .createDefaultBooleanStateClusterServer(true)
      .addRequiredClusters();

    const printer: Printer = {
      config: entry,
      read: createReader(type, entry.url, entry.apiKey),
      light,
      sensor,
    };
    for (const [endpoint, label] of [
      [light, progressName],
      [sensor, statusName],
    ] as const) {
      const id = endpoint.id ?? label;
      this.setSelectDevice(id, label);
      if (this.validateDevice([label, id])) await this.registerDevice(endpoint);
    }
    return printer;
  }

  private poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.pollTask)
      this.pollTask = Promise.all(this.printers.map((printer) => this.refresh(printer)))
        .then(() => undefined)
        .finally(() => {
          this.pollTask = undefined;
        });
    return this.pollTask;
  }

  private async refresh(printer: Printer): Promise<void> {
    if (this.stopped) return;
    let reading: Reading | null = null;
    try {
      reading = await printer.read();
    } catch (error) {
      if (printer.last !== null)
        this.log.warn(
          `${printer.config.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (this.stopped) return;
    if (
      reading &&
      (printer.last?.progress !== reading.progress || printer.last?.printing !== reading.printing)
    )
      this.log.info(
        `${printer.config.name}: ${reading.progress}%${reading.printing ? " (printing)" : ""}`,
      );
    printer.last = reading;
    await this.apply(printer, reading);
  }

  private async apply(printer: Printer, reading: Reading | null): Promise<void> {
    const online = reading !== null;
    for (const endpoint of [printer.light, printer.sensor]) {
      if (endpoint.getAttribute(BridgedDeviceBasicInformation, "reachable") !== online)
        await endpoint.setAttribute(BridgedDeviceBasicInformation, "reachable", online, this.log);
    }
    if (!reading) return;
    const on = reading.progress > 0;
    if (printer.light.getAttribute(OnOff, "onOff") !== on)
      await printer.light.setAttribute(OnOff, "onOff", on, this.log);
    const level = toLevel(reading.progress);
    if (printer.light.getAttribute(LevelControl, "currentLevel") !== level)
      await printer.light.setAttribute(LevelControl, "currentLevel", level, this.log);
    const contact = !reading.printing;
    if (printer.sensor.getAttribute(BooleanState, "stateValue") !== contact)
      await printer.sensor.setAttribute(BooleanState, "stateValue", contact, this.log);
  }
}
