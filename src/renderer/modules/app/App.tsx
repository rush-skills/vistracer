import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTracerouteSubscription } from "@renderer/hooks/useTracerouteSubscription";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { TopBar } from "./components/TopBar";
import { GlobeViewport } from "./components/GlobeViewport";
import { HopDetailsPane } from "./components/HopDetailsPane";
import { FooterBar } from "./components/FooterBar";
import { OnboardingModal } from "./components/OnboardingModal";
import { UpdateBanner } from "./components/UpdateBanner";
import { Toolbar } from "./components/Toolbar";
import { LayerPanel } from "./components/LayerPanel";
import { HopTimeline } from "./components/HopTimeline";
import { HoverCard } from "./components/HoverCard";
import { CommandPalette } from "./components/CommandPalette";
import { useUpdateStore } from "@renderer/state/updateStore";
import { selectTheme, useUiStore } from "@renderer/state/uiStore";
import { UI_EVENTS } from "./lib/uiEvents";
import "./app.css";

interface OnboardingPreferences {
  skipOnLaunch?: boolean;
  lastCompletedAt?: number;
  lastDismissedAt?: number;
}

const UPDATE_CHECK_DELAY_MS = 5000;

export const App: React.FC = () => {
  useTracerouteSubscription();

  const currentRun = useTracerouteStore(selectCurrentRun);
  const selectedHopIndex = useTracerouteStore((state) => state.selectedHopIndex);
  const status = useTracerouteStore((state) => state.status);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(true);
  const [showOnLaunch, setShowOnLaunch] = useState(true);
  const onboardingPrefsRef = useRef<OnboardingPreferences>({});
  const theme = useUiStore(selectTheme);

  useEffect(() => {
    void useUiStore.getState().load();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Check for updates in the background after start-up settles.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void useUpdateStore.getState().check();
    }, UPDATE_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let mounted = true;

    const evaluateOnboarding = async () => {
      try {
        const prefs =
          (await window.visTracer.getSettings<OnboardingPreferences>("preferences.onboarding")) ??
          {};

        if (!mounted) {
          return;
        }

        onboardingPrefsRef.current = prefs;
        const skip = prefs.skipOnLaunch ?? false;
        setShowOnLaunch(!skip);
        setIsOnboardingOpen(!skip);
      } catch (error) {
        console.warn("Failed to evaluate onboarding state", error);
        if (mounted) {
          setIsOnboardingOpen(true);
          setShowOnLaunch(true);
        }
      }
    };

    void evaluateOnboarding();

    const handleShowOnboarding = () => {
      setIsOnboardingOpen(true);
    };

    window.addEventListener(UI_EVENTS.SHOW_ONBOARDING, handleShowOnboarding);

    return () => {
      mounted = false;
      window.removeEventListener(UI_EVENTS.SHOW_ONBOARDING, handleShowOnboarding);
    };
  }, []);

  const applyOnboardingPrefs = useCallback(async (patch: Partial<OnboardingPreferences>) => {
    const next = { ...onboardingPrefsRef.current, ...patch };
    onboardingPrefsRef.current = next;
    try {
      await window.visTracer.setSettings("preferences.onboarding", next);
    } catch (error) {
      console.error("Failed to persist onboarding preferences", error);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "skipOnLaunch")) {
      setShowOnLaunch(!(next.skipOnLaunch ?? false));
    }
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    setIsOnboardingOpen(false);
    void applyOnboardingPrefs({ lastCompletedAt: Date.now() });
  }, [applyOnboardingPrefs]);

  const handleOnboardingDismiss = useCallback(() => {
    setIsOnboardingOpen(false);
    void applyOnboardingPrefs({ lastDismissedAt: Date.now() });
  }, [applyOnboardingPrefs]);

  const handleConfigureGeo = useCallback(() => {
    setIsOnboardingOpen(false);
    void applyOnboardingPrefs({ lastCompletedAt: Date.now() });
    window.dispatchEvent(new CustomEvent(UI_EVENTS.OPEN_SETTINGS_MODAL));
  }, [applyOnboardingPrefs]);

  const handleReviewIntegrations = useCallback(() => {
    setIsOnboardingOpen(false);
    void applyOnboardingPrefs({ lastCompletedAt: Date.now() });
    window.dispatchEvent(new CustomEvent(UI_EVENTS.EXPAND_INTEGRATIONS_PANEL));
  }, [applyOnboardingPrefs]);

  const handleToggleShowOnLaunch = useCallback(
    (shouldShow: boolean) => {
      setShowOnLaunch(shouldShow);
      void applyOnboardingPrefs({ skipOnLaunch: !shouldShow });
      if (!shouldShow) {
        setIsOnboardingOpen(false);
      }
    },
    [applyOnboardingPrefs]
  );

  return (
    <div className="app-shell">
      <GlobeViewport run={currentRun} selectedHopIndex={selectedHopIndex} />
      <div className="hud">
        <div className="hud__trace">
          <TopBar />
        </div>
        <div className="hud__tools">
          <Toolbar />
          <LayerPanel />
        </div>
        <div className="hud__hops">
          <HopDetailsPane run={currentRun} selectedHopIndex={selectedHopIndex} status={status} />
        </div>
        <div className="hud__timeline">
          <HopTimeline run={currentRun} selectedHopIndex={selectedHopIndex} />
        </div>
        <div className="hud__status">
          <FooterBar />
        </div>
      </div>
      <HoverCard />
      <CommandPalette />
      <UpdateBanner />
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onComplete={handleOnboardingComplete}
        onDismiss={handleOnboardingDismiss}
        onConfigureGeo={handleConfigureGeo}
        onReviewIntegrations={handleReviewIntegrations}
        showOnLaunch={showOnLaunch}
        onToggleShowOnLaunch={handleToggleShowOnLaunch}
      />
    </div>
  );
};
