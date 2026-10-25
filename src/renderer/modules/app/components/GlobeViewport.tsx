import React, { useEffect, useMemo, useRef, useState } from "react";
import type { TracerouteRun } from "@common/ipc";
import {
  INITIAL_CAMERA_TRACKER,
  buildGlobeScene,
  hopPosition,
  nextCameraFocus,
  type CameraTracker
} from "@renderer/lib/globe";
import { imageryForLayers, layerVisibility, sceneForLayers } from "@renderer/lib/layers";
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
  const scene = useMemo(
    () => sceneForLayers(buildGlobeScene(hops, selectedHopIndex, hoveredHopIndex), visibility),
    [hops, selectedHopIndex, hoveredHopIndex, visibility]
  );
  const imagery = useMemo(() => imageryForLayers(visibility), [visibility]);

  useEffect(() => {
    controller?.setScene(scene);
  }, [controller, scene]);

  useEffect(() => {
    controller?.setImagery(imagery);
  }, [controller, imagery]);

  useEffect(() => {
    if (!controller) {
      return;
    }
    const { tracker, focus } = nextCameraFocus(trackerRef.current, runKey, hops, selectedHopIndex);
    trackerRef.current = tracker;
    if (focus) {
      controller.flyTo(focus);
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
