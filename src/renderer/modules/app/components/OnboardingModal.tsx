import React, { useEffect, useMemo, useState } from "react";
import type { GeoDatabaseMeta } from "@common/ipc";
import type { IconType } from "react-icons";
import {
  FiCamera,
  FiCheckCircle,
  FiDownloadCloud,
  FiGlobe,
  FiLayers,
  FiNavigation,
  FiSettings,
  FiTrendingUp,
  FiX
} from "react-icons/fi";
import "./OnboardingModal.css";

interface OnboardingModalProps {
  isOpen: boolean;
  onComplete: () => void;
  onDismiss: () => void;
  onConfigureGeo: () => void;
  onReviewIntegrations: () => void;
  showOnLaunch: boolean;
  onToggleShowOnLaunch: (nextShowOnLaunch: boolean) => void;
}

interface StepConfig {
  title: string;
  description: string;
  icon: IconType;
}

const STEP_CONFIG: StepConfig[] = [
  {
    title: "Point VisTracer at a host",
    description:
      "Enter a domain or IP, pick ICMP/UDP/TCP, and run a local traceroute to stream hops in real time.",
    icon: FiNavigation
  },
  {
    title: "Load GeoLite2 databases",
    description:
      "Drop in the City and ASN MaxMind files so hops light up on the globe with location + ASN context.",
    icon: FiGlobe
  },
  {
    title: "Layer in enrichment",
    description:
      "Toggle Team Cymru, RDAP, RIPE Stat, and PeeringDB to fill metadata gaps or confirm GeoIP output.",
    icon: FiLayers
  },
  {
    title: "Capture and share",
    description:
      "Export stills or animations once the run completes to include in incident reports or status updates.",
    icon: FiCamera
  }
];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onComplete,
  onDismiss,
  onConfigureGeo,
  onReviewIntegrations,
  showOnLaunch,
  onToggleShowOnLaunch
}) => {
  const [geoMeta, setGeoMeta] = useState<GeoDatabaseMeta | null>(null);
  const [geoError, setGeoError] = useState<string | undefined>(undefined);
  const [loadingGeo, setLoadingGeo] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;
    setLoadingGeo(true);
    window.visTracer
      .getGeoDatabaseMeta()
      .then((meta) => {
        if (cancelled) {
          return;
        }
        setGeoMeta(meta);
        setGeoError(undefined);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Failed to load GeoIP database status.";
        setGeoError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingGeo(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const geoStatusLabel = useMemo(() => {
    if (loadingGeo) {
      return "Checking GeoLite2 status…";
    }
    if (geoError) {
      return geoError;
    }
    if (!geoMeta) {
      return "GeoLite2 databases not configured yet. Fallback lookups will run with lower accuracy.";
    }

    const cityReady = geoMeta.cityDbStatus === "loaded";
    const asnReady = geoMeta.asnDbStatus === "loaded";

    if (cityReady && asnReady) {
      return "GeoLite2 City + ASN databases detected.";
    }

    if (cityReady || asnReady) {
      return "Only one GeoLite2 database is loaded — fallback services fill the remaining gaps.";
    }

    return (
      geoMeta.statusMessage ??
      "GeoLite2 databases missing. Fallback services will estimate locations but may drift."
    );
  }, [geoMeta, geoError, loadingGeo]);

  const geoStatusVariant = useMemo(() => {
    if (loadingGeo) {
      return "neutral";
    }
    if (geoError) {
      return "warning";
    }
    if (geoMeta?.cityDbStatus === "loaded" && geoMeta.asnDbStatus === "loaded") {
      return "ready";
    }
    return "warning";
  }, [geoMeta, geoError, loadingGeo]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="onboarding-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-modal-title"
      onClick={onDismiss}
    >
      <div
        className="onboarding-modal__panel"
        role="document"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="onboarding-modal__close"
          onClick={onDismiss}
          aria-label="Dismiss onboarding"
        >
          <FiX />
        </button>
        <div className="onboarding-modal__content">
          <div className="onboarding-modal__header">
            <div className="onboarding-modal__eyebrow">Welcome to VisTracer</div>
            <h2 id="onboarding-modal-title">Visual traceroute, ready for takeoff</h2>
            <p>
              Run traceroute from your own network, enrich each hop, and animate the path across the
              globe. Complete these quick steps to get the best experience.
            </p>
          </div>

          <div className="onboarding-modal__steps">
            {STEP_CONFIG.map((step) => {
              const Icon = step.icon;
              return (
                <article key={step.title} className="onboarding-modal__step">
                  <div className="onboarding-modal__step-icon">
                    <Icon />
                  </div>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="onboarding-modal__status-row">
            <div className={`onboarding-modal__status onboarding-modal__status--${geoStatusVariant}`}>
              <FiDownloadCloud />
              <span>{geoStatusLabel}</span>
            </div>
            <button className="onboarding-modal__link" onClick={onConfigureGeo}>
              <FiSettings />
              Configure GeoLite2
            </button>
          </div>

          <div className="onboarding-modal__actions">
            <button className="onboarding-modal__action onboarding-modal__action--primary" onClick={onComplete}>
              <FiCheckCircle />
              Start tracing
            </button>
            <button className="onboarding-modal__action" onClick={onReviewIntegrations}>
              <FiTrendingUp />
              Review integrations
            </button>
          </div>

          <label className="onboarding-modal__checkbox">
            <input
              type="checkbox"
              checked={!showOnLaunch}
              onChange={(event) => onToggleShowOnLaunch(!event.target.checked)}
            />
            Don&apos;t show this guide on launch
          </label>
        </div>
      </div>
    </div>
  );
};
