import React, { useEffect, useMemo, useRef, useState } from "react";
import type { TracerouteRun } from "@common/ipc";
import {
  INITIAL_CAMERA_TRACKER,
  buildGlobeScene,
  hopPosition,
  nextCameraFocus,
  type CameraTracker,
  type ViewInsets
} from "@renderer/lib/globe";
import { MAX_CLUSTER_LEVEL } from "@renderer/lib/infra/cluster";
import {
  imageryForLayers,
  layerVisibility,
  sceneForLayers,
  styleForLayers
} from "@renderer/lib/layers";
import { useInfraScene } from "@renderer/hooks/useInfra";
import { useSatelliteDrawing } from "@renderer/hooks/useSatellites";
import { useInfraStore } from "@renderer/state/infraStore";
import { useNoticeStore } from "@renderer/state/noticeStore";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import type { GlobeController } from "./globe/controller";
import "./GlobeViewport.css";

interface GlobeViewportProps {
  run?: TracerouteRun;
  selectedHopIndex?: number;
}

/** How long the "detailed imagery unavailable" note stays after the last failed tile. */
const IMAGERY_NOTICE_MS = 30_000;

/** Attribute of the panels a flight frames the hop around (see `ViewInsets`). */
export const GLOBE_INSET = "data-globe-inset";

/**
 * Pixels of each canvas edge that the panels marked with GLOBE_INSET cover
 * ("top", "right", "bottom", "left"). Collapsed panels are small, so they
 * cost little; a hidden panel has no size.
 */
export function measureInsets(canvas: HTMLElement): ViewInsets {
  const box = canvas.getBoundingClientRect();
  const insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const panel of document.querySelectorAll<HTMLElement>(`[${GLOBE_INSET}]`)) {
    const rect = panel.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      continue;
    }
    const edge = panel.getAttribute(GLOBE_INSET);
    if (edge === "right") {
      insets.right = Math.max(insets.right, box.right - rect.left);
    } else if (edge === "bottom") {
      insets.bottom = Math.max(insets.bottom, box.bottom - rect.top);
    } else if (edge === "top") {
      insets.top = Math.max(insets.top, rect.bottom - box.top);
    } else if (edge === "left") {
      insets.left = Math.max(insets.left, rect.right - box.left);
    }
  }
  return insets;
}

export const GlobeViewport: React.FC<GlobeViewportProps> = ({ run, selectedHopIndex }) => {
  const hoveredHopIndex = useTracerouteStore((state) => state.hoveredHopIndex);
  const captureActive = useTracerouteStore((state) => state.captureActive);
  const savedLayers = useUiStore((state) => state.layers);
  const visibility = useMemo(() => layerVisibility(savedLayers), [savedLayers]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [controller, setController] = useState<GlobeController | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [imageryNotice, setImageryNotice] = useState(false);
  const trackerRef = useRef<CameraTracker>(INITIAL_CAMERA_TRACKER);
  const [clusterLevel, setClusterLevel] = useState(MAX_CLUSTER_LEVEL);
  const hoveredSiteKey = useInfraStore((state) => state.hoveredSite?.specKey);
  const infra = useInfraScene(clusterLevel);
  const satellites = useSatelliteDrawing();
  // The adapter's callbacks are made once; they read the latest clusters here.
  const membersRef = useRef(infra.members);
  membersRef.current = infra.members;
  const runKey = run ? `${run.summary.target}@${run.summary.startedAt}` : undefined;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let created: GlobeController | null = null;
    let disposed = false;
    let noticeTimer: number | undefined;
    const { selectHopByUser, setHoveredHop } = useTracerouteStore.getState();
    import("./globe/cesiumGlobe")
      .then(({ createCesiumGlobe }) => {
        if (disposed) {
          return;
        }
        created = createCesiumGlobe(container, {
          onSelectHop: selectHopByUser,
          onHoverHop: (hopIndex, at) =>
            setHoveredHop(hopIndex, at && { kind: "point", x: at.x, y: at.y }),
          onHoverSite: (key, at, heightKm) => {
            // Satellite keys are "sat|<group>|<NORAD id>" (lib/infra/sources.ts).
            const site = key?.startsWith("sat|")
              ? { layer: "satellites" as const, keys: [key], heightKm }
              : key
                ? membersRef.current(key)
                : undefined;
            useInfraStore
              .getState()
              .setHoveredSite(
                key && site && at
                  ? { specKey: key, ...site, anchor: { kind: "point", x: at.x, y: at.y } }
                  : undefined
              );
          },
          onSatelliteError: (message) =>
            useNoticeStore
              .getState()
              .show(`The satellites could not be drawn: ${message}`, "error"),
          onClusterLevel: setClusterLevel,
          onImageryError: () => {
            setImageryNotice(true);
            window.clearTimeout(noticeTimer);
            noticeTimer = window.setTimeout(() => setImageryNotice(false), IMAGERY_NOTICE_MS);
          }
        });
        setController(created);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          const message = error instanceof Error ? error.message : String(error);
          setLoadError(message);
        }
      });
    return () => {
      disposed = true;
      window.clearTimeout(noticeTimer);
      created?.destroy();
      setController(null);
    };
  }, []);

  const hops = useMemo(() => run?.hops ?? [], [run]);
  const style = useMemo(() => styleForLayers(visibility), [visibility]);
  const route = useMemo(
    () => buildGlobeScene(hops, selectedHopIndex, hoveredHopIndex, style),
    [hops, selectedHopIndex, hoveredHopIndex, style]
  );
  const scene = useMemo(
    () => sceneForLayers({ ...route, ...infra.scene }, visibility),
    [route, infra.scene, visibility]
  );
  const imagery = useMemo(() => imageryForLayers(visibility), [visibility]);

  useEffect(() => {
    controller?.setScene(scene);
  }, [controller, scene]);

  useEffect(() => {
    controller?.setImagery(imagery);
  }, [controller, imagery]);

  useEffect(() => {
    controller?.setHoveredSite(hoveredSiteKey);
  }, [controller, hoveredSiteKey]);

  useEffect(() => {
    controller?.setSatellites(satellites);
  }, [controller, satellites]);

  useEffect(() => {
    if (!controller) {
      return;
    }
    const { tracker, focus } = nextCameraFocus(trackerRef.current, runKey, hops, selectedHopIndex);
    trackerRef.current = tracker;
    if (focus) {
      // An export records the canvas without the panels, so its flights
      // centre the hop in the whole canvas.
      const canvas = containerRef.current;
      const exporting = useTracerouteStore.getState().captureActive;
      controller.flyTo(focus, canvas && !exporting ? measureInsets(canvas) : undefined);
    }
  }, [controller, runKey, hops, selectedHopIndex]);

  useEffect(() => {
    controller?.setInputEnabled(!captureActive);
  }, [controller, captureActive]);

  const hasRenderableHops = hops.some((hop) => hopPosition(hop));

  return (
    <section className="globe-viewport" aria-label="3D globe showing traceroute path">
      <div ref={containerRef} className="globe-viewport__canvas" />
      {loadError && (
        <p className="globe-viewport__overlay globe-viewport__overlay--error" role="alert">
          The globe could not start: {loadError}. It needs WebGL; the hop table still works.
        </p>
      )}
      {!loadError && run && !hasRenderableHops && (
        <p className="globe-viewport__overlay">Waiting for geolocation data…</p>
      )}
      {imageryNotice && (
        <p className="globe-viewport__notice" role="status">
          Detailed imagery is unavailable (offline?); showing the bundled imagery.
        </p>
      )}
    </section>
  );
};
