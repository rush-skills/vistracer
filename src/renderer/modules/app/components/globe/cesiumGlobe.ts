import {
  Cartesian2,
  Cartesian3,
  CesiumWidget,
  Color,
  EasingFunction,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  HorizontalOrigin,
  ImageryLayer,
  JulianDate,
  LabelCollection,
  Material,
  Math as CesiumMath,
  PerspectiveFrustum,
  PointPrimitiveCollection,
  PolylineCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  WebMercatorTilingScheme,
  type TileProviderError
} from "cesium";
import "cesium/Build/Cesium/Widgets/CesiumWidget/CesiumWidget.css";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CAMERA_LIMITS,
  borderRings,
  kmPerPixel,
  planFlight,
  type Emphasis,
  type FlightStep,
  type GeoPoint,
  type GlobeScene
} from "@renderer/lib/globe";
import { clusterLevel } from "@renderer/lib/infra/cluster";
import {
  BUNDLED_IMAGERY,
  CanvasDrag,
  NIGHT_BRIGHTNESS,
  ONLINE_IMAGERY,
  OnlineImageryGate,
  bundledOnlyHeight,
  nightImageryShare,
  onlineTileTemplate
} from "@renderer/lib/imagery";
import { prefersReducedMotion } from "@renderer/lib/motion";
import { GOVERNOR_RULES, RenderGovernor, renderQuality } from "@renderer/lib/renderGovernor";
import type { CreateGlobe } from "./controller";

// Cesium loads its workers and images from here. vite.config.ts serves the
// folder in development and copies it into the build.
window.CESIUM_BASE_URL = new URL("./cesium/", document.baseURI).href;

const BACKGROUND = Color.fromCssColorString("#0d0e14");
const GLOBE_BASE = Color.fromCssColorString("#0a1220");
const MARKER_OUTLINE = Color.fromCssColorString("rgba(8, 10, 16, 0.9)");
const LABEL_BACKGROUND = Color.fromCssColorString("rgba(12, 14, 21, 0.85)");
const LABEL_FONT = "600 13px system-ui, -apple-system, 'Segoe UI', sans-serif";
const SITE_LABEL_FONT = "500 12px system-ui, -apple-system, 'Segoe UI', sans-serif";
const BORDER_COLOR = Color.WHITE.withAlpha(0.22);
const FLY_SECONDS = 1.2;
const RISE_SECONDS = 0.6;
const HOVER_PICK_MS = 50;
/** Objects to look through under the pointer: two arcs, then the marker. */
const PICK_DEPTH = 4;
const MINIMIZED_CHECK_MS = 150;

const MARKER_STYLE: Record<Emphasis, { pixelSize: number; outline: Color; outlineWidth: number }> =
  {
    normal: { pixelSize: 9, outline: MARKER_OUTLINE, outlineWidth: 1.5 },
    hovered: { pixelSize: 12, outline: Color.WHITE, outlineWidth: 2 },
    selected: { pixelSize: 14, outline: Color.WHITE, outlineWidth: 2.5 }
  };

interface HopId {
  hopIndex: number;
}

/** Site markers and cable lines: the spec key, for the hover card. */
interface SiteId {
  siteKey: string;
}

function pickedId(picked: unknown): object | undefined {
  if (typeof picked !== "object" || picked === null || !("id" in picked)) {
    return undefined;
  }
  const id: unknown = picked.id;
  return typeof id === "object" && id !== null ? id : undefined;
}

/** The hop of a picked marker or ring; `scene.pick` returns untyped objects. */
function pickedHopIndex(picked: unknown): number | undefined {
  const id = pickedId(picked);
  return id && "hopIndex" in id && typeof id.hopIndex === "number" ? id.hopIndex : undefined;
}

function pickedSiteKey(picked: unknown): string | undefined {
  const id = pickedId(picked);
  return id && "siteKey" in id && typeof id.siteKey === "string" ? id.siteKey : undefined;
}

type PickTarget = { kind: "hop"; hopIndex: number } | { kind: "site"; key: string };

const toCartesians = (points: GeoPoint[]) =>
  Cartesian3.fromDegreesArrayHeights(
    points.flatMap((point) => [point.longitude, point.latitude, point.height])
  );

const toCartesian = (point: GeoPoint) =>
  Cartesian3.fromDegrees(point.longitude, point.latitude, point.height);

const solid = (color: Color) => Material.fromType("Color", { color });
const dashed = (color: Color, dashLength: number) =>
  Material.fromType("PolylineDash", { color, gapColor: Color.TRANSPARENT, dashLength });

interface BatteryLike extends EventTarget {
  charging: boolean;
}

export const createCesiumGlobe: CreateGlobe = (container, callbacks) => {
  const quality = renderQuality(window.devicePixelRatio);
  const widget = new CesiumWidget(container, {
    // Every ion default off: no base layer (ion/Bing), no ion terrain, no
    // star box (which would also add sun and moon textures).
    baseLayer: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    skyBox: false,
    scene3DOnly: true,
    orderIndependentTranslucency: false,
    shadows: false,
    useDefaultRenderLoop: false,
    requestRenderMode: true,
    // The clock never triggers frames; the governor moves the sun.
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    shouldAnimate: false,
    useBrowserRecommendedResolution: false,
    msaaSamples: quality.msaaSamples,
    // Credits render as plain text in GlobeViewport: Cesium's credit links
    // would navigate the app window.
    creditContainer: document.createElement("div"),
    contextOptions: {
      webgl: {
        alpha: false,
        // Exports read the canvas after the frame (exportCapture.ts).
        preserveDrawingBuffer: true,
        powerPreference: "low-power"
      }
    }
  });
  widget.resolutionScale = quality.resolutionScale;

  const { scene, camera, canvas } = widget;
  const globe = scene.globe;
  globe.enableLighting = true;
  globe.showGroundAtmosphere = false;
  globe.baseColor = GLOBE_BASE;
  scene.backgroundColor = BACKGROUND;
  scene.fog.enabled = false;
  scene.postProcessStages.fxaa.enabled = false;
  scene.highDynamicRange = false;

  const geographic = new GeographicTilingScheme();
  const bundled = (url: string) =>
    new UrlTemplateImageryProvider({
      url,
      tilingScheme: geographic,
      maximumLevel: BUNDLED_IMAGERY.maximumLevel,
      hasAlphaChannel: false
    });
  // Night lights under the day imagery: with lighting on, each layer shows
  // on its side of the terminator. `dayLayers` also cover the dark side when
  // the camera comes close (see the preRender listener below).
  const nightLayer = new ImageryLayer(bundled(BUNDLED_IMAGERY.night), {
    dayAlpha: 0,
    nightAlpha: 1,
    brightness: NIGHT_BRIGHTNESS
  });
  const dayLayers = [
    new ImageryLayer(bundled(BUNDLED_IMAGERY.day), { dayAlpha: 1, nightAlpha: 0 })
  ];
  scene.imageryLayers.add(nightLayer);
  scene.imageryLayers.add(dayLayers[0]);
  const onlineTemplate = onlineTileTemplate(isTauri() ? convertFileSrc : undefined);
  let onlineLayer: ImageryLayer | undefined;
  if (onlineTemplate) {
    const online = new UrlTemplateImageryProvider({
      url: onlineTemplate,
      tilingScheme: new WebMercatorTilingScheme(),
      maximumLevel: ONLINE_IMAGERY.maximumLevel,
      hasAlphaChannel: false
    });
    // A listener also stops Cesium from logging every failed tile.
    online.errorEvent.addEventListener((error: TileProviderError) =>
      callbacks.onImageryError(error.message)
    );
    onlineLayer = new ImageryLayer(online, {
      dayAlpha: 1,
      nightAlpha: 0,
      minimumTerrainLevel: ONLINE_IMAGERY.minimumTerrainLevel
    });
    dayLayers.push(onlineLayer);
    scene.imageryLayers.add(onlineLayer);
  }
  const onlineGate = new OnlineImageryGate();
  let onlineEnabled = true;
  let dayNight = true;
  // Switched off, the online layer is not in the collection at all, so
  // Cesium cannot ask it for a tile. Switched on, the gate decides.
  const syncOnlineLayer = () => {
    if (!onlineLayer) {
      return;
    }
    const inScene = scene.imageryLayers.contains(onlineLayer);
    if (!onlineEnabled && inScene) {
      scene.imageryLayers.remove(onlineLayer, false);
    } else if (onlineEnabled && !inScene) {
      scene.imageryLayers.add(onlineLayer);
    }
    onlineLayer.show = onlineGate.visible;
  };
  // Hidden from the start, until the user moves the camera.
  syncOnlineLayer();
  // Runs only for frames that are drawn anyway, so it adds no frames.
  const removePreRender = scene.preRender.addEventListener(() => {
    const share = dayNight
      ? nightImageryShare(
          Cartesian3.magnitude(camera.positionWC),
          globe.lightingFadeOutDistance,
          globe.lightingFadeInDistance
        )
      : 0;
    nightLayer.nightAlpha = share;
    for (const layer of dayLayers) {
      layer.nightAlpha = 1 - share;
    }
  });

  const controls = scene.screenSpaceCameraController;
  controls.minimumZoomDistance = CAMERA_LIMITS.minHeight;
  controls.maximumZoomDistance = CAMERA_LIMITS.maxHeight;
  controls.enableLook = false;
  camera.setView({ destination: Cartesian3.fromDegrees(15, 25, CAMERA_LIMITS.initialHeight) });

  // `fov` spans the larger side of the canvas (the height in a portrait window).
  const frustumFov = () =>
    camera.frustum instanceof PerspectiveFrustum && camera.frustum.fov !== undefined
      ? camera.frustum.fov
      : CesiumMath.PI_OVER_THREE;
  const largerSide = () => Math.max(canvas.clientWidth, canvas.clientHeight);
  let framesDrawn = 0;
  let level: number | undefined;
  const removePostRender = scene.postRender.addEventListener(() => {
    framesDrawn += 1;
    // Only on frames drawn anyway: a new level re-clusters the site layers.
    const next = clusterLevel(
      kmPerPixel(camera.positionCartographic.height, frustumFov(), largerSide())
    );
    if (next !== level) {
      level = next;
      callbacks.onClusterLevel(next);
    }
  });
  const governor = new RenderGovernor(
    () => {
      const before = framesDrawn;
      // The sun follows the wall clock whenever a frame is drawn anyway.
      JulianDate.now(widget.clock.currentTime);
      widget.resize();
      widget.render();
      return framesDrawn > before;
    },
    {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle)
    }
  );
  // Cesium asks for frames through requestRender() (tile loads, resizes,
  // API changes). The governor's loop may be asleep, so the call wakes it.
  const requestRender = scene.requestRender.bind(scene);
  scene.requestRender = () => {
    requestRender();
    governor.wake();
  };

  // Added in draw order: borders and cables under the route, the
  // infrastructure sites under the hop markers, labels on top.
  const borders = new PolylineCollection();
  const cableLines = new PolylineCollection();
  const lines = new PolylineCollection();
  const sitePoints = new PointPrimitiveCollection();
  const markers = new PointPrimitiveCollection();
  const cableLabels = new LabelCollection({ scene });
  const siteLabels = new LabelCollection({ scene });
  const labels = new LabelCollection({ scene });
  for (const collection of [
    borders,
    cableLines,
    lines,
    sitePoints,
    markers,
    cableLabels,
    siteLabels,
    labels
  ]) {
    scene.primitives.add(collection);
  }

  let destroyed = false;
  void fetch("./world.geojson")
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json() as Promise<unknown>;
    })
    .then((geojson) => {
      if (destroyed) {
        return;
      }
      for (const ring of borderRings(geojson)) {
        borders.add({
          positions: Cartesian3.fromDegreesArray(ring.flat()),
          width: 1,
          // One material per line: each polyline destroys its own material,
          // so a shared one would make widget.destroy() throw.
          material: solid(BORDER_COLOR)
        });
      }
      scene.requestRender();
    })
    .catch((error: unknown) => {
      console.warn("Country borders are not drawn: world.geojson did not load.", error);
    });

  /** A hop wins over a site: hops are what the user traced. */
  const pickTarget = (position: Cartesian2): PickTarget | undefined => {
    const picked: unknown = scene.pick(position);
    if (picked === undefined) {
      return undefined;
    }
    const hopIndex = pickedHopIndex(picked);
    if (hopIndex != null) {
      return { kind: "hop", hopIndex };
    }
    // Arcs end at the markers and draw over them; look underneath.
    const below: unknown[] = scene.drillPick(position, PICK_DEPTH);
    const hopBelow = below.map(pickedHopIndex).find((index) => index != null);
    if (hopBelow != null) {
      return { kind: "hop", hopIndex: hopBelow };
    }
    const key = [picked, ...below].map(pickedSiteKey).find((siteKey) => siteKey != null);
    return key ? { kind: "site", key } : undefined;
  };

  const clickHandler = new ScreenSpaceEventHandler(canvas);
  clickHandler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
    const target = pickTarget(event.position);
    if (target?.kind === "hop") {
      callbacks.onSelectHop(target.hopIndex);
    }
  }, ScreenSpaceEventType.LEFT_CLICK);

  let hovered: PickTarget | undefined;
  let hoverPosition: Cartesian2 | undefined;
  let hoverClient: { x: number; y: number } | undefined;
  let hoverTimer: number | undefined;
  // While a hop or site stays under the pointer, each pick (at most every
  // HOVER_PICK_MS) passes the new pointer position for the hover card.
  const setHovered = (target: PickTarget | undefined) => {
    if (target === undefined && hovered === undefined) {
      return;
    }
    const before = hovered;
    hovered = target;
    canvas.style.cursor = target?.kind === "hop" ? "pointer" : "";
    if (target?.kind === "hop" || before?.kind === "hop") {
      callbacks.onHoverHop(target?.kind === "hop" ? target.hopIndex : undefined, hoverClient);
    }
    if (target?.kind === "site" || before?.kind === "site") {
      callbacks.onHoverSite(target?.kind === "site" ? target.key : undefined, hoverClient);
    }
  };
  const pickHover = () => {
    hoverTimer = undefined;
    setHovered(hoverPosition ? pickTarget(hoverPosition) : undefined);
  };
  const wake = () => governor.wake();
  const userMovedCamera = () => {
    if (onlineGate.userMovedCamera()) {
      syncOnlineLayer();
    }
    governor.wake();
  };
  const drag = new CanvasDrag();
  const onPointerDown = () => {
    drag.pressOnCanvas();
    governor.wake();
  };
  const onPointerRelease = () => drag.release();
  const onPointerMove = (event: PointerEvent) => {
    if (event.buttons !== 0) {
      // A drag rotates, zooms or tilts the camera; picking would only slow
      // it down. A press that started outside the globe moves nothing.
      if (drag.isDragging(event.buttons)) {
        userMovedCamera();
      }
      return;
    }
    drag.release();
    const rect = canvas.getBoundingClientRect();
    hoverPosition = new Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
    hoverClient = { x: event.clientX, y: event.clientY };
    hoverTimer ??= window.setTimeout(pickHover, HOVER_PICK_MS);
  };
  const onPointerLeave = () => {
    hoverPosition = undefined;
    hoverClient = undefined;
    window.clearTimeout(hoverTimer);
    hoverTimer = undefined;
    setHovered(undefined);
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", wake);
  // The release can happen over a panel or outside the window.
  window.addEventListener("pointerup", onPointerRelease);
  window.addEventListener("pointercancel", onPointerRelease);
  canvas.addEventListener("wheel", userMovedCamera, { passive: true });
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  const resizeObserver = new ResizeObserver(wake);
  resizeObserver.observe(container);

  let minimized = false;
  const updateVisibility = () =>
    governor.setVisible(document.visibilityState === "visible" && !minimized);
  // Not every webview reports a minimized window as hidden, so the Tauri
  // window is asked too: after a resize and on every visibility change.
  const appWindow = isTauri() ? getCurrentWindow() : undefined;
  const checkMinimized = () => {
    void appWindow
      ?.isMinimized()
      .then((value) => {
        if (!destroyed) {
          minimized = value;
          updateVisibility();
        }
      })
      .catch(() => undefined);
  };
  const onVisibilityChange = () => {
    updateVisibility();
    checkMinimized();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  let unlistenResize: (() => void) | undefined;
  let minimizedTimer: number | undefined;
  void appWindow
    ?.onResized(() => {
      window.clearTimeout(minimizedTimer);
      minimizedTimer = window.setTimeout(checkMinimized, MINIMIZED_CHECK_MS);
    })
    .then((unlisten) => {
      if (destroyed) {
        unlisten();
      } else {
        unlistenResize = unlisten;
      }
    })
    .catch(() => undefined);

  let removeBatteryListener: (() => void) | undefined;
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
  void nav
    .getBattery?.()
    .then((battery) => {
      if (destroyed) {
        return;
      }
      const update = () => governor.setOnBattery(!battery.charging);
      update();
      battery.addEventListener("chargingchange", update);
      removeBatteryListener = () => battery.removeEventListener("chargingchange", update);
    })
    .catch(() => undefined);

  const sunTimer = window.setInterval(() => scene.requestRender(), GOVERNOR_RULES.sunRefreshMs);
  const reducedMotion = prefersReducedMotion();

  let last: GlobeScene | undefined;
  const drawRoute = (spec: GlobeScene) => {
    lines.removeAll();
    markers.removeAll();
    labels.removeAll();
    for (const ring of spec.rings) {
      const color = Color.fromCssColorString(ring.color).withAlpha(ring.opacity);
      lines.add({
        id: { hopIndex: ring.hopIndex } satisfies HopId,
        positions: toCartesians(ring.positions),
        width: ring.lineWidth,
        material: ring.dashed ? dashed(color, 12) : solid(color)
      });
    }
    for (const reach of spec.reaches) {
      lines.add({
        id: { hopIndex: reach.hopIndex } satisfies HopId,
        positions: toCartesians(reach.positions),
        width: 1.5,
        material: dashed(Color.fromCssColorString(reach.color).withAlpha(reach.opacity), 6)
      });
    }
    for (const arc of spec.arcs) {
      lines.add({
        positions: toCartesians(arc.positions),
        width: 7,
        material: Material.fromType("PolylineGlow", {
          color: Color.fromCssColorString(arc.color),
          glowPower: 0.22,
          taperPower: 1
        })
      });
    }
    for (const marker of spec.markers) {
      const style = MARKER_STYLE[marker.emphasis];
      markers.add({
        id: { hopIndex: marker.hopIndex } satisfies HopId,
        position: toCartesian(marker.position),
        pixelSize: style.pixelSize,
        color: Color.fromCssColorString(marker.color),
        outlineColor: style.outline,
        outlineWidth: style.outlineWidth
      });
    }
    for (const label of spec.labels) {
      labels.add({
        id: { hopIndex: label.hopIndex } satisfies HopId,
        position: toCartesian(label.position),
        text: label.text,
        font: LABEL_FONT,
        fillColor: Color.WHITE,
        showBackground: true,
        backgroundColor: LABEL_BACKGROUND,
        backgroundPadding: new Cartesian2(7, 5),
        pixelOffset: new Cartesian2(0, -14),
        verticalOrigin: VerticalOrigin.BOTTOM,
        horizontalOrigin: HorizontalOrigin.CENTER
      });
    }
  };
  const drawSites = (spec: GlobeScene) => {
    sitePoints.removeAll();
    siteLabels.removeAll();
    for (const site of [...spec.facilities, ...spec.exchanges, ...spec.cloudRegions]) {
      const position = toCartesian(site.position);
      sitePoints.add({
        id: { siteKey: site.key } satisfies SiteId,
        position,
        pixelSize: site.pixelSize,
        color: Color.fromCssColorString(site.color),
        outlineColor: Color.fromCssColorString(site.outline),
        outlineWidth: site.outlineWidth
      });
      if (site.label) {
        siteLabels.add({
          id: { siteKey: site.key } satisfies SiteId,
          position,
          text: site.label,
          font: SITE_LABEL_FONT,
          fillColor: Color.WHITE,
          showBackground: true,
          backgroundColor: LABEL_BACKGROUND,
          backgroundPadding: new Cartesian2(6, 4),
          pixelOffset: new Cartesian2(0, 12),
          verticalOrigin: VerticalOrigin.TOP,
          horizontalOrigin: HorizontalOrigin.CENTER
        });
      }
    }
  };
  const drawCables = (spec: GlobeScene) => {
    cableLines.removeAll();
    cableLabels.removeAll();
    for (const cable of spec.cables) {
      cableLines.add({
        id: { siteKey: cable.key } satisfies SiteId,
        positions: toCartesians(cable.positions),
        width: cable.width,
        material: solid(Color.fromCssColorString(cable.color))
      });
      if (cable.label) {
        cableLabels.add({
          id: { siteKey: cable.key } satisfies SiteId,
          position: toCartesian(cable.label.position),
          text: cable.label.text,
          font: SITE_LABEL_FONT,
          fillColor: Color.WHITE,
          showBackground: true,
          backgroundColor: LABEL_BACKGROUND,
          backgroundPadding: new Cartesian2(6, 4),
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER
        });
      }
    }
  };

  scene.requestRender();

  return {
    setScene(spec: GlobeScene) {
      // Each group is rebuilt only when its lists changed, so a hover on
      // the route does not rebuild a thousand cable lines.
      const routeChanged =
        !last ||
        spec.markers !== last.markers ||
        spec.arcs !== last.arcs ||
        spec.rings !== last.rings ||
        spec.reaches !== last.reaches ||
        spec.labels !== last.labels;
      const sitesChanged =
        !last ||
        spec.exchanges !== last.exchanges ||
        spec.facilities !== last.facilities ||
        spec.cloudRegions !== last.cloudRegions;
      const cablesChanged = !last || spec.cables !== last.cables;
      last = spec;
      if (routeChanged) {
        drawRoute(spec);
      }
      if (sitesChanged) {
        drawSites(spec);
      }
      if (cablesChanged) {
        drawCables(spec);
      }
      if (routeChanged || sitesChanged || cablesChanged) {
        scene.requestRender();
      }
    },

    flyTo(focus, insets) {
      // A new app flight cancels the running one. The cancelled flight only
      // ends the gate's flight state; OnlineImageryGate keeps the online
      // layer hidden until the user moves the camera.
      camera.cancelFlight();
      const position = camera.positionCartographic;
      const floor = bundledOnlyHeight({
        levelGeometricErrorM: scene.terrainProvider.getLevelMaximumGeometricError(
          ONLINE_IMAGERY.minimumTerrainLevel - 1
        ),
        // The screen size too, so a larger window later at the same height
        // still needs no online level.
        viewportPx: Math.max(
          canvas.clientWidth,
          canvas.clientHeight,
          window.screen.width,
          window.screen.height
        ),
        fovRad: frustumFov(),
        maximumScreenSpaceError: globe.maximumScreenSpaceError
      });
      const steps = planFlight(
        {
          latitude: CesiumMath.toDegrees(position.latitude),
          longitude: CesiumMath.toDegrees(position.longitude),
          height: position.height
        },
        focus,
        floor,
        insets && {
          insets,
          widthPx: canvas.clientWidth,
          heightPx: canvas.clientHeight,
          fovRad: frustumFov()
        }
      );
      // App-made moves load no online tiles, not even the wider view while
      // the camera rises. The layer stays hidden after the move until the
      // user zooms, drags or tilts (OnlineImageryGate).
      onlineGate.appFlightStarted();
      syncOnlineLayer();
      const fly = (step: FlightStep, next: FlightStep[]) => {
        camera.flyTo({
          destination: Cartesian3.fromDegrees(step.longitude, step.latitude, step.height),
          orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
          duration: reducedMotion ? 0 : step.kind === "rise" ? RISE_SECONDS : FLY_SECONDS,
          // A flat path: without it, Cesium arcs the camera out towards space.
          maximumHeight: Math.max(step.height, camera.positionCartographic.height),
          easingFunction: EasingFunction.QUADRATIC_IN_OUT,
          complete: () =>
            next.length > 0 ? fly(next[0], next.slice(1)) : onlineGate.appFlightEnded(),
          cancel: () => onlineGate.appFlightEnded()
        });
        scene.requestRender();
      };
      fly(steps[0], steps.slice(1));
    },

    setInputEnabled(enabled) {
      // Not enableInputs: every Cesium flight sets it to true when it ends
      // (CameraFlightPath), which would unlock the camera during an export.
      // Flights leave these switches alone; enableLook stays off.
      controls.enableRotate = enabled;
      controls.enableZoom = enabled;
      controls.enableTilt = enabled;
      controls.enableTranslate = enabled;
      onlineGate.setInputLocked(!enabled);
    },

    setImagery(options) {
      dayNight = options.dayNight;
      globe.enableLighting = dayNight;
      nightLayer.show = dayNight;
      onlineEnabled = options.online;
      syncOnlineLayer();
      scene.requestRender();
    },

    destroy() {
      destroyed = true;
      governor.dispose();
      window.clearInterval(sunTimer);
      window.clearTimeout(hoverTimer);
      window.clearTimeout(minimizedTimer);
      unlistenResize?.();
      removeBatteryListener?.();
      removePostRender();
      removePreRender();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", wake);
      window.removeEventListener("pointerup", onPointerRelease);
      window.removeEventListener("pointercancel", onPointerRelease);
      canvas.removeEventListener("wheel", userMovedCamera);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      clickHandler.destroy();
      widget.destroy();
    }
  };
};
