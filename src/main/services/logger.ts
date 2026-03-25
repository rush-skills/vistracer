import log from "electron-log/main";

export function initializeLogger(): void {
  log.initialize();
  log.transports.file.level = process.env.NODE_ENV === "development" ? "silly" : "info";
  log.transports.console.level = "info";
  log.info("Logger initialized");
}

export function getLogger() {
  return log;
}
