import { app, BrowserWindow, nativeImage, nativeTheme } from "electron";
import path from "node:path";
import { setupIpcHandlers } from "./services/ipc";
import { initializeLogger } from "./services/logger";
import { ensureAppDataDirs, configureGeoDatabaseDefaults } from "./services/persistence";

const isDev = process.env.NODE_ENV === "development";

let mainWindow: BrowserWindow | null = null;

function resolveAssetPath(...segments: string[]): string {
  const baseDir = app.isPackaged
    ? path.join(process.resourcesPath, "assets")
    : path.join(app.getAppPath(), "assets");

  return path.join(baseDir, ...segments);
}

function getPlatformIconPath(): string {
  if (process.platform === "win32") {
    return resolveAssetPath("icons", "VisTracer.ico");
  }

  if (process.platform === "darwin") {
    return resolveAssetPath("icons", "VisTracer.icns");
  }

  return resolveAssetPath("icons", "VisTracer.png");
}

async function createMainWindow(): Promise<void> {
  const iconPath = getPlatformIconPath();
  const windowIcon = nativeImage.createFromPath(iconPath);

  if (process.platform === "darwin" && app.dock && !windowIcon.isEmpty()) {
    app.dock.setIcon(windowIcon);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1f21" : "#f5f7fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    title: "VisTracer",
    icon: windowIcon.isEmpty() ? undefined : windowIcon
  });

  if (isDev) {
    const devServerURL =
      process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL || "http://localhost:5173";
    await mainWindow.loadURL(devServerURL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexHtml = path.join(app.getAppPath(), "dist", "renderer", "index.html");
    await mainWindow.loadFile(indexHtml);
  }
}

function registerAppEvents(): void {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
}

async function bootstrap(): Promise<void> {
  initializeLogger();
  setupIpcHandlers();

  await app.whenReady();
  await ensureAppDataDirs();
  await configureGeoDatabaseDefaults();
  await createMainWindow();
  registerAppEvents();
}

bootstrap().catch((error) => {
  console.error("Failed to bootstrap application", error);
  app.exit(1);
});
