import React from "react";
import { useTracerouteSubscription } from "@renderer/hooks/useTracerouteSubscription";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { TopBar } from "./components/TopBar";
import { GlobeViewport } from "./components/GlobeViewport";
import { HopDetailsPane } from "./components/HopDetailsPane";
import { FooterBar } from "./components/FooterBar";
import "./app.css";

export const App: React.FC = () => {
  useTracerouteSubscription();

  const currentRun = useTracerouteStore(selectCurrentRun);
  const selectedHopIndex = useTracerouteStore((state) => state.selectedHopIndex);
  const status = useTracerouteStore((state) => state.status);

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-content">
        <GlobeViewport run={currentRun} selectedHopIndex={selectedHopIndex} />
        <HopDetailsPane run={currentRun} selectedHopIndex={selectedHopIndex} status={status} />
      </div>
      <FooterBar />
    </div>
  );
};
